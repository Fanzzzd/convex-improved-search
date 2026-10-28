/// <reference types="vite/client" />
/**
 * Fixed read-cost benchmark for `search` (see .judge/gate.md when present).
 * Skipped unless CIS_BENCH=1. Prints one JSON line per workload, prefixed
 * "BENCH ", and writes them to CIS_BENCH_OUT when set:
 *
 *   CIS_BENCH=1 CIS_BENCH_OUT=/tmp/bench.jsonl npx vitest run src/component/cost.bench.test.ts
 *
 * Metrics are convex-test transaction counts (index ranges, rows read), so
 * they are deterministic. The file only uses the 0.4.0 search interface plus
 * an optional `fields` arg, which it drops (filtering matchedFields instead)
 * when the build under test rejects it, so it runs unchanged on older SHAs.
 */
import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { documentGramsOfFields, firstCodepoint, fold } from "./grams.js";

type T = ReturnType<typeof initConvexTest>;
type Entry = {
	key: string;
	fields: Record<string, string>;
	sortKey: number;
	filters?: Record<string, string | number | boolean | null>;
};
type Args = {
	query: string;
	fields?: string[];
	filters?: Record<string, string | number | boolean | null>;
	limit?: number;
	budget?: number;
};
type Page = {
	page: { key: string; sortKey: number; matchedFields: string[] }[];
	cursor: string | null;
	isDone: boolean;
};
type Cost = { calls: number; ranges: number; rows: number; maxCallRanges: number; maxCallRows: number; hits: number; done: boolean };

const NS = "bench";

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

function documentNumbers(): Entry[] {
	const entries: Entry[] = [];
	let sortKey = 0;
	for (let day = 0; day < 365; day++) {
		const date = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
		const ymd = `26${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
		for (let n = 1; n <= 10; n++) {
			sortKey += 1;
			const no = `TR-${ymd}-${String(n).padStart(3, "0")}`;
			entries.push({
				key: no,
				fields: { no, memo: sortKey % 97 === 0 ? "補單，原單 TR-260720-006" : "司機墊付停車費" },
				sortKey,
			});
		}
	}
	return entries;
}

const ALPHABET = ["停", "車", "費", "港", "a", "b", "A", "Ｂ", "１", "1", " ", "-", "̃", "😀", "\u{1D4B3}", "\u0001"];
function randomText(rand: () => number, max: number): string {
	let text = "";
	const length = Math.floor(rand() * (max + 1));
	for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
	return text;
}
function hostile(rand: () => number): Entry[] {
	return Array.from({ length: 2000 }, (_, i) => ({
		key: `h${String(i).padStart(4, "0")}`,
		fields: rand() < 0.5 ? { text: randomText(rand, 30) } : { a: randomText(rand, 15), b: randomText(rand, 15) },
		sortKey: Math.floor(rand() * 200),
	}));
}
function hostileQueries(rand: () => number, entries: Entry[]): string[] {
	return Array.from({ length: 50 }, () => {
		if (rand() < 0.5) {
			const entry = entries[Math.floor(rand() * entries.length)];
			const texts = Object.values(entry.fields).filter((text) => text.length > 0);
			if (texts.length > 0) {
				const codepoints = Array.from(texts[Math.floor(rand() * texts.length)]);
				const start = Math.floor(rand() * codepoints.length);
				const length = 1 + Math.floor(rand() * Math.min(5, codepoints.length - start));
				return codepoints.slice(start, start + length).join("");
			}
		}
		return randomText(rand, 4) || "停";
	});
}
function selectiveFilter(): Entry[] {
	return Array.from({ length: 3000 }, (_, i) => ({
		key: `f${String(i).padStart(4, "0")}`,
		fields: { text: "停車費" },
		sortKey: i,
		filters: { rare: i % 100 === 0 },
	}));
}

/** The rows `set` writes, in one transaction. */
async function seed(t: T, entries: Entry[]) {
	await t.run(async (ctx) => {
		for (const entry of entries) {
			const fields = Object.fromEntries(Object.entries(entry.fields).map(([name, value]) => [name, fold(value)]));
			await ctx.db.insert("docs", {
				namespace: NS,
				key: entry.key,
				fields,
				sortKey: entry.sortKey,
				...(entry.filters === undefined ? {} : { filters: entry.filters }),
			});
			for (const gram of documentGramsOfFields(fields)) {
				await ctx.db.insert("postings", { namespace: NS, key: entry.key, gram, g1: firstCodepoint(gram), sortKey: entry.sortKey });
			}
		}
	});
}

let fieldsSupported: boolean | null = null;

/** Up to `maxCalls` searches; `perTransaction` puts them all in one transaction (the incident loop). */
async function measure(t: T, args: Args, maxCalls: number, perTransaction: boolean): Promise<Cost> {
	const cost: Cost = { calls: 0, ranges: 0, rows: 0, maxCallRanges: 0, maxCallRows: 0, hits: 0, done: false };
	let cursor: string | null = null;
	const run = async (calls: number) =>
		await t.run(async (ctx) => {
			for (let i = 0; i < calls && !cost.done; i++) {
				const before = await ctx.meta.getTransactionMetrics();
				const { fields, ...rest } = args;
				let page: Page;
				if (fields !== undefined && fieldsSupported !== false) {
					try {
						page = await ctx.runQuery(api.lib.search, { namespace: NS, ...rest, fields, cursor } as never);
						fieldsSupported = true;
					} catch (error) {
						if (fieldsSupported === true || !String(error).includes("fields")) throw error;
						fieldsSupported = false;
						i -= 1;
						continue;
					}
				} else {
					page = await ctx.runQuery(api.lib.search, { namespace: NS, ...rest, cursor });
				}
				const after = await ctx.meta.getTransactionMetrics();
				const ranges = after.databaseQueries.used - before.databaseQueries.used;
				const rows = after.documentsRead.used - before.documentsRead.used;
				const hits =
					fields === undefined || fieldsSupported
						? page.page
						: page.page.filter((hit) => hit.matchedFields.some((name) => fields.includes(name)));
				cost.calls += 1;
				cost.ranges += ranges;
				cost.rows += rows;
				cost.maxCallRanges = Math.max(cost.maxCallRanges, ranges);
				cost.maxCallRows = Math.max(cost.maxCallRows, rows);
				cost.hits += hits.length;
				cost.done = page.isDone;
				cursor = page.cursor;
			}
		});
	if (perTransaction) {
		await run(maxCalls);
	} else {
		for (let i = 0; i < maxCalls && !cost.done; i++) await run(1);
	}
	return cost;
}

function report(workload: string, cost: Cost) {
	const line = JSON.stringify({ workload, ...cost });
	console.log(`BENCH ${line}`);
	if (process.env.CIS_BENCH_OUT) appendFileSync(process.env.CIS_BENCH_OUT, `${line}\n`);
}

test.skipIf(!process.env.CIS_BENCH)("search read-cost benchmark", { timeout: 1_200_000 }, async () => {
	const numbers = initConvexTest();
	await seed(numbers, documentNumbers());
	report("W1 TR-260720-006 drain", await measure(numbers, { query: "TR-260720-006", limit: 50 }, 500, false));
	report(
		"W2 TR-26 memo, 5 calls budget 512 in one transaction",
		await measure(numbers, { query: "TR-26", fields: ["memo"], budget: 512, limit: 50 }, 5, true),
	);
	report("W3 停車 first page", await measure(numbers, { query: "停車", limit: 50 }, 1, false));
	report("W4 0 first page", await measure(numbers, { query: "0", limit: 50 }, 1, false));

	const rand = prng(20261028);
	const entries = hostile(rand);
	const random = initConvexTest();
	await seed(random, entries);
	const total: Cost = { calls: 0, ranges: 0, rows: 0, maxCallRanges: 0, maxCallRows: 0, hits: 0, done: true };
	for (const query of hostileQueries(rand, entries)) {
		const cost = await measure(random, { query, limit: 50 }, 500, false);
		expect(cost.done).toBe(true);
		total.calls += cost.calls;
		total.ranges += cost.ranges;
		total.rows += cost.rows;
		total.maxCallRanges = Math.max(total.maxCallRanges, cost.maxCallRanges);
		total.maxCallRows = Math.max(total.maxCallRows, cost.maxCallRows);
		total.hits += cost.hits;
	}
	report("W5 hostile corpus, 50 queries drained", total);

	const filtered = initConvexTest();
	await seed(filtered, selectiveFilter());
	report("W6 停車 filter rare drain", await measure(filtered, { query: "停車", filters: { rare: true }, limit: 50 }, 500, false));
});
