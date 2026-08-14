/// <reference types="vite/client" />
/**
 * Randomized differential test: the indexed search must return EXACTLY the
 * documents a naive full scan finds with `fold(text).includes(fold(query))`.
 *
 * This is the correctness methodology of the reference implementations —
 * Lucene's TestNGramTokenizer checks the tokenizer against a brute-force
 * codepoint oracle, and SQLancer's NoREC diffs an index-accelerated query
 * against a form the engine cannot optimize. The alphabet is deliberately
 * tiny and nasty: heavy gram collisions, CJK, full/half width, combining
 * marks, surrogate pairs, and the sentinel codepoint itself.
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

/** A random codepoint-aligned substring of a random document, or a random string. */
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

function oracle(docs: Map<string, { text: string; sortKey: number }>, query: string): string[] {
	const foldedQuery = fold(query);
	if (foldedQuery.length === 0) return [];
	return [...docs.entries()]
		.filter(([, doc]) => fold(doc.text).includes(foldedQuery))
		.sort(([ka, a], [kb, b]) => b.sortKey - a.sortKey || (kb > ka ? 1 : -1))
		.map(([key]) => key);
}

async function drain(
	t: ReturnType<typeof initConvexTest>,
	query: string,
	limit: number,
	budget?: number,
): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | null = null;
	for (let round = 0; round < 1000; round++) {
		const result: { page: { key: string }[]; cursor: string | null; isDone: boolean } =
			await t.query(api.lib.search, { namespace: NS, query, cursor, limit, budget });
		keys.push(...result.page.map((row) => row.key));
		if (result.isDone) return keys;
		cursor = result.cursor;
	}
	throw new Error("search did not terminate");
}

test.each([20260814, 424242, 7])("index ≡ naive scan over a hostile corpus, through writes, updates and deletes (seed %i)", async (seed) => {
	const rand = prng(seed);
	const t = initConvexTest();
	const docs = new Map<string, { text: string; sortKey: number }>();

	// Phase 1: index a fresh corpus.
	for (let i = 0; i < 60; i++) {
		const key = `k${String(i).padStart(2, "0")}`;
		const doc = { text: randomText(rand, 30), sortKey: Math.floor(rand() * 10) };
		docs.set(key, doc);
		await t.mutation(api.lib.set, { namespace: NS, key, ...doc });
	}
	const texts = () => [...docs.values()].map((doc) => doc.text);
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
			const doc = { text: randomText(rand, 30), sortKey: Math.floor(rand() * 10) };
			docs.set(key, doc);
			await t.mutation(api.lib.set, { namespace: NS, key, ...doc });
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
	test("oracle itself is substring semantics", () => {
		const docs = new Map([
			["a", { text: "停車費", sortKey: 2 }],
			["b", { text: "停 車", sortKey: 1 }],
		]);
		expect(oracle(docs, "停車")).toEqual(["a"]);
		expect(oracle(docs, "停")).toEqual(["a", "b"]);
	});
});
