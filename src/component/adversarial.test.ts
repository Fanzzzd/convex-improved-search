/// <reference types="vite/client" />
/**
 * Index states `set` alone rarely produces: pending-reap leftovers (stale
 * and duplicate postings, postings of removed docs), large tie groups,
 * sortKey -0, and keys that order differently in UTF-8 than in JS.
 */
import { compareValues } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { firstCodepoint, fold, gramFieldsOf } from "./grams.js";

type T = ReturnType<typeof initConvexTest>;
type Entry = { key: string; fields: Record<string, string>; sortKey: number };
type Extra = { gram: string; sortKey: number; key?: string; fields?: string[] };

const NS = "adv";

function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The rows `set` writes, plus `extra` posting rows per entry. `untagged` entries look written before 0.5.0. */
async function seed(
	t: T,
	entries: Entry[],
	extra: (entry: Entry) => Extra[] = () => [],
	untagged: (entry: Entry) => boolean = () => false,
) {
	await t.run(async (ctx) => {
		for (const entry of entries) {
			const fields = Object.fromEntries(
				Object.entries(entry.fields).map(([name, value]) => [name, fold(value)]),
			);
			await ctx.db.insert("docs", { namespace: NS, key: entry.key, fields, sortKey: entry.sortKey });
			const rows: Extra[] = [...gramFieldsOf(fields)].map(([gram, tag]) => ({
				gram,
				sortKey: entry.sortKey,
				fields: untagged(entry) ? undefined : tag,
			}));
			for (const row of [...rows, ...extra(entry)]) {
				await ctx.db.insert("postings", {
					namespace: NS,
					key: row.key ?? entry.key,
					gram: row.gram,
					g1: firstCodepoint(row.gram),
					sortKey: row.sortKey,
					...(row.fields === undefined ? {} : { fields: row.fields }),
				});
			}
		}
	});
}

type Drained = { hits: string[]; calls: number; maxCallRanges: number; maxCallRows: number };

async function drain(
	t: T,
	args: { query: string; limit: number; budget?: number; fields?: string[] },
	maxCalls = 2000,
): Promise<Drained> {
	const drained: Drained = { hits: [], calls: 0, maxCallRanges: 0, maxCallRows: 0 };
	let cursor: string | null = null;
	for (let i = 0; i < maxCalls; i++) {
		const done = await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const page = await ctx.runQuery(api.lib.search, { namespace: NS, ...args, cursor });
			const after = await ctx.meta.getTransactionMetrics();
			drained.calls += 1;
			drained.maxCallRanges = Math.max(drained.maxCallRanges, after.databaseQueries.used - before.databaseQueries.used);
			drained.maxCallRows = Math.max(drained.maxCallRows, after.documentsRead.used - before.documentsRead.used);
			drained.hits.push(...page.page.map((hit) => `${hit.key}|${[...hit.matchedFields].sort().join(",")}`));
			cursor = page.cursor;
			return page.isDone;
		});
		if (done) return drained;
	}
	throw new Error(`search for ${JSON.stringify(args.query)} did not finish in ${maxCalls} calls`);
}

function oracle(entries: Entry[], query: string, fields?: string[]): string[] {
	const folded = fold(query);
	return entries
		.map((entry) => ({
			entry,
			matched: Object.entries(entry.fields)
				.filter(([name, text]) => (fields === undefined || fields.includes(name)) && fold(text).includes(folded))
				.map(([name]) => name)
				.sort(),
		}))
		.filter(({ matched }) => matched.length > 0)
		.sort((a, b) => compareValues(b.entry.sortKey, a.entry.sortKey) || compareValues(b.entry.key, a.entry.key))
		.map(({ entry, matched }) => `${entry.key}|${matched.join(",")}`);
}

describe("search over a messy index", () => {
	test("index ≡ naive scan with stale, duplicate and orphan postings, tied sortKeys and astral keys", { timeout: 600_000 }, async () => {
		const rand = prng(99);
		const alphabet = ["停", "車", "a", "b", "😀", "", "�", "1"];
		const keyChars = ["a", "", "￿", "😀", "\u{10FFFF}", "z", "\u0000"];
		const text = (max: number) =>
			Array.from({ length: Math.floor(rand() * (max + 1)) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
		const entries: Entry[] = [];
		const seen = new Set<string>();
		while (entries.length < 300) {
			const key = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => keyChars[Math.floor(rand() * keyChars.length)]).join("");
			if (seen.has(key)) continue;
			seen.add(key);
			const sortKey = [-0, 0, 1, 2][Math.floor(rand() * 4)];
			entries.push({ key, fields: rand() < 0.5 ? { text: text(12) } : { a: text(6), b: text(6) }, sortKey });
		}
		const t = initConvexTest();
		const bogus = () => (rand() < 0.5 ? ["b"] : undefined);
		await seed(
			t,
			entries,
			(entry) => {
				const rows: Extra[] = [];
				const tags = gramFieldsOf(Object.fromEntries(Object.entries(entry.fields).map(([n, v]) => [n, fold(v)])));
				// A pending reap: duplicates (an old sortKey carries any tag; `set`
				// retags rows at the current one), and a gram the doc no longer has.
				if (rand() < 0.3) {
					for (const [gram, tag] of tags) {
						if (rand() >= 0.5) continue;
						const sortKey = Math.floor(rand() * 3);
						rows.push({ gram, sortKey, fields: Object.is(sortKey, entry.sortKey) ? tag : bogus() });
					}
				}
				if (rand() < 0.3) {
					const gram = alphabet[Math.floor(rand() * 8)] + alphabet[Math.floor(rand() * 8)];
					if (!tags.has(gram)) rows.push({ gram, sortKey: Math.floor(rand() * 3), fields: bogus() });
				}
				// Postings of a removed doc.
				if (rand() < 0.1) rows.push({ gram: "停車", sortKey: Math.floor(rand() * 3), key: `gone-${entry.key}`, fields: bogus() });
				return rows;
			},
			() => rand() < 0.2,
		);
		for (let i = 0; i < 60; i++) {
			const query = text(4) || "停";
			for (const [limit, budget, fields] of [
				[7, undefined, undefined],
				[3, 4, undefined],
				[5, undefined, ["a"]],
				[5, undefined, ["text", "b"]],
			] as const) {
				const wanted = fields === undefined ? undefined : [...fields];
				const { hits } = await drain(t, { query, limit, budget, fields: wanted });
				expect(hits, `query ${JSON.stringify(query)} limit ${limit} fields ${fields}`).toEqual(
					oracle(entries, query, wanted),
				);
			}
		}
	});

	test("pages through entries whose sortKey is -0", async () => {
		const entries = Array.from({ length: 40 }, (_, i) => ({ key: `n${String(i).padStart(2, "0")}`, fields: { text: "停車費" }, sortKey: -0 }));
		const t = initConvexTest();
		await seed(t, entries);
		for (const query of ["停車", "停"]) {
			const { hits } = await drain(t, { query, limit: 7 }, 30);
			expect(hits).toEqual(oracle(entries, query));
		}
	});

	test("a plan the corpus outgrows swaps its candidate gram mid-call and loses nothing", { timeout: 600_000 }, async () => {
		// "ab" is sparse in the newest 400 and in every older doc; "bc" the
		// reverse. The probe picks "ab", which turns dense further on.
		const entries = Array.from({ length: 2000 }, (_, i) => {
			const hasAB = i < 400 ? i % 40 === 0 : true;
			const hasBC = i < 400 ? true : i % 100 === 0;
			return {
				key: `d${String(i).padStart(5, "0")}`,
				fields: { text: (hasAB ? "xab" : "x") + (hasBC ? " bc" : "") + (hasAB && hasBC && i % 2 === 0 ? " abc" : "") },
				sortKey: 2000 - i,
			};
		});
		const t = initConvexTest();
		await seed(t, entries);
		for (const limit of [3, 50]) {
			const drained = await drain(t, { query: "abc", limit });
			expect(drained.hits, `limit ${limit}`).toEqual(oracle(entries, "abc"));
			expect(drained.maxCallRows).toBeLessThan(2000);
		}
	});

	test("dense candidates switch a call to walking docs alone, and back when they thin out", { timeout: 600_000 }, async () => {
		// The newest 300 all hold 停車 (half match 停車場); the older 600 hold
		// it 1 in 20. Two Fields, so `fields` and tags also take part.
		const entries = Array.from({ length: 900 }, (_, i) => {
			const dense = i < 300;
			const holds = dense || i % 20 === 0;
			const text = holds ? (i % 2 === 0 ? "停車場月租" : "停車費") : "過磅單";
			return {
				key: `e${String(i).padStart(4, "0")}`,
				fields: i % 3 === 0 ? { title: text, memo: "x" } : { title: "y", memo: text },
				sortKey: 900 - i,
			};
		});
		const t = initConvexTest();
		await seed(t, entries);
		for (const [query, limit, budget, fields] of [
			["停車場", 200, undefined, undefined],
			["停車場", 40, 64, undefined],
			["停車", 7, undefined, undefined],
			["停", 50, 100, undefined],
			["停車場", 50, undefined, ["memo"]],
		] as const) {
			const wanted = fields === undefined ? undefined : [...fields];
			const drained = await drain(t, { query, limit, budget, fields: wanted });
			expect(drained.hits, `${query} limit ${limit} budget ${budget} fields ${fields}`).toEqual(
				oracle(entries, query, wanted),
			);
		}
	});

	test("a large tie group costs each call a bounded number of rows", { timeout: 600_000 }, async () => {
		// Every entry shares sortKey 0; "abcx" is in 1 of 50, its other grams in all of them.
		const entries = Array.from({ length: 3000 }, (_, i) => ({
			key: `k${String(i).padStart(5, "0")}`,
			fields: { text: i % 50 === 0 ? "zabcxz" : `zabcz${i % 7}` },
			sortKey: 0,
		}));
		const t = initConvexTest();
		await seed(t, entries);
		const drained = await drain(t, { query: "abcx", limit: 50 });
		expect(drained.hits).toEqual(oracle(entries, "abcx"));
		expect(drained.maxCallRows).toBeLessThan(8000);
		expect(drained.maxCallRanges).toBeLessThan(1024);
	});
});
