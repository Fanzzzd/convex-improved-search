/// <reference types="vite/client" />
/**
 * Randomized differential test: the indexed search must return EXACTLY the
 * documents a naive full scan finds with `fold(field).includes(fold(query))`
 * over any field — including which fields matched.
 *
 * This is the correctness methodology of the reference implementations —
 * Lucene's TestNGramTokenizer checks the tokenizer against a brute-force
 * codepoint oracle, and SQLancer's NoREC diffs an index-accelerated query
 * against a form the engine cannot optimize. The alphabet is deliberately
 * tiny and nasty: heavy gram collisions, CJK, full/half width, combining
 * marks, surrogate pairs, and the sentinel codepoint itself. Two-field
 * entries additionally pin down that matches never span a field boundary.
 */
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { fold } from "./grams.js";

const NS = "diff";

// Mulberry32 — deterministic, seedable.
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

const ALPHABET = [
	"停", "車", "費", "港", // small CJK set → heavy bigram collisions
	"a", "b", "A", "Ｂ", "１", "1", // case + width folding
	" ", "-", "̃", // space, punctuation, combining tilde
	"😀", "\u{1D4B3}", // surrogate pair; math X (NFKC-folds to "x")
	"\u0001", // the sentinel itself — collisions must be absorbed by verification
] as const;

function randomText(rand: () => number, maxLength: number): string {
	const length = Math.floor(rand() * (maxLength + 1));
	let text = "";
	for (let i = 0; i < length; i++) {
		text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
	}
	return text;
}

type Entry = { fields: Record<string, string>; sortKey: number };

/** Half single-field entries, half two-field — the boundary must not leak matches. */
function randomEntry(rand: () => number): Entry {
	const sortKey = Math.floor(rand() * 10);
	if (rand() < 0.5) return { fields: { text: randomText(rand, 30) }, sortKey };
	return { fields: { a: randomText(rand, 15), b: randomText(rand, 15) }, sortKey };
}

const wire = (fields: Record<string, string>) =>
	Object.entries(fields).map(([name, value]) => ({ name, value }));

/** A random codepoint-aligned substring of a random field, or a random string. */
function randomQuery(rand: () => number, texts: string[]): string {
	if (rand() < 0.5 && texts.length > 0) {
		const text = texts[Math.floor(rand() * texts.length)];
		const codepoints = Array.from(text);
		if (codepoints.length > 0) {
			const start = Math.floor(rand() * codepoints.length);
			const len = 1 + Math.floor(rand() * Math.min(5, codepoints.length - start));
			return codepoints.slice(start, start + len).join("");
		}
	}
	return randomText(rand, 4) || ALPHABET[Math.floor(rand() * ALPHABET.length)];
}

type Hit = { key: string; matchedFields: string[] };

function oracle(docs: Map<string, Entry>, query: string): Hit[] {
	const foldedQuery = fold(query);
	if (foldedQuery.length === 0) return [];
	return [...docs.entries()]
		.map(([key, doc]) => ({
			key,
			sortKey: doc.sortKey,
			matchedFields: Object.entries(doc.fields)
				.filter(([, value]) => fold(value).includes(foldedQuery))
				.map(([name]) => name)
				.sort(),
		}))
		.filter((row) => row.matchedFields.length > 0)
		.sort((a, b) => b.sortKey - a.sortKey || (b.key > a.key ? 1 : -1))
		.map(({ key, matchedFields }) => ({ key, matchedFields }));
}

async function drain(
	t: ReturnType<typeof initConvexTest>,
	query: string,
	limit: number,
	budget?: number,
): Promise<Hit[]> {
	const hits: Hit[] = [];
	let cursor: string | null = null;
	for (let round = 0; round < 1000; round++) {
		const result: {
			page: { key: string; matchedFields: string[] }[];
			cursor: string | null;
			isDone: boolean;
		} = await t.query(api.lib.search, { namespace: NS, query, cursor, limit, budget });
		hits.push(
			...result.page.map((row) => ({
				key: row.key,
				matchedFields: [...row.matchedFields].sort(),
			})),
		);
		if (result.isDone) return hits;
		cursor = result.cursor;
	}
	throw new Error("search did not terminate");
}

test.each([20260814, 424242, 7])("index ≡ naive scan over a hostile corpus, through writes, updates and deletes (seed %i)", async (seed) => {
	const rand = prng(seed);
	const t = initConvexTest();
	const docs = new Map<string, Entry>();

	// Phase 1: index a fresh corpus.
	for (let i = 0; i < 60; i++) {
		const key = `k${String(i).padStart(2, "0")}`;
		const doc = randomEntry(rand);
		docs.set(key, doc);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key,
			fields: wire(doc.fields),
			sortKey: doc.sortKey,
		});
	}
	const texts = () => [...docs.values()].flatMap((doc) => Object.values(doc.fields));
	for (let i = 0; i < 60; i++) {
		const query = randomQuery(rand, texts());
		expect(await drain(t, query, 7), `query ${JSON.stringify(query)}`).toEqual(
			oracle(docs, query),
		);
	}

	// Phase 2: mutate — updates (gram diff paths), sortKey moves, deletes.
	const keys = [...docs.keys()];
	for (const key of keys) {
		const roll = rand();
		if (roll < 0.3) {
			const doc = randomEntry(rand);
			docs.set(key, doc);
			await t.mutation(api.lib.set, {
				namespace: NS,
				key,
				fields: wire(doc.fields),
				sortKey: doc.sortKey,
			});
		} else if (roll < 0.45) {
			docs.delete(key);
			await t.mutation(api.lib.remove, { namespace: NS, key });
		}
	}
	for (let i = 0; i < 60; i++) {
		const query = randomQuery(rand, texts());
		expect(await drain(t, query, 7), `query ${JSON.stringify(query)}`).toEqual(
			oracle(docs, query),
		);
	}

	// Phase 3: the same equivalence must hold under a starvation-level budget.
	for (let i = 0; i < 20; i++) {
		const query = randomQuery(rand, texts());
		expect(await drain(t, query, 3, 4), `query ${JSON.stringify(query)}`).toEqual(
			oracle(docs, query),
		);
	}
}, 120_000);

describe("oracle sanity", () => {
	test("oracle itself is per-field substring semantics", () => {
		const docs = new Map<string, Entry>([
			["a", { fields: { text: "停車費" }, sortKey: 2 }],
			["b", { fields: { x: "停", y: "車" }, sortKey: 1 }],
		]);
		expect(oracle(docs, "停車")).toEqual([{ key: "a", matchedFields: ["text"] }]);
		expect(oracle(docs, "停")).toEqual([
			{ key: "a", matchedFields: ["text"] },
			{ key: "b", matchedFields: ["x"] },
		]);
	});
});
