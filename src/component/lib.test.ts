/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { TestConvex } from "convex-test";
import type schema from "./schema.js";

const NS = "test";

type T = TestConvex<typeof schema>;

async function seed(
	t: T,
	docs: {
		key: string;
		text: string;
		sortKey: number;
		filters?: Record<string, string | number | boolean | null>;
	}[],
) {
	for (const doc of docs) {
		await t.mutation(api.lib.set, { namespace: NS, ...doc });
	}
}

/** Drain the search to completion; asserts every page keeps (sortKey desc, key desc) order. */
async function searchAll(
	t: T,
	query: string,
	options?: {
		filters?: Record<string, string | number | boolean | null>;
		limit?: number;
		budget?: number;
	},
): Promise<string[]> {
	const keys: string[] = [];
	let previous: { s: number; k: string } | null = null;
	let cursor: string | null = null;
	for (let round = 0; round < 500; round++) {
		const result: {
			page: { key: string; sortKey: number }[];
			cursor: string | null;
			isDone: boolean;
		} = await t.query(api.lib.search, {
			namespace: NS,
			query,
			cursor,
			...options,
		});
		for (const row of result.page) {
			if (previous !== null) {
				expect(
					row.sortKey < previous.s ||
						(row.sortKey === previous.s && row.key < previous.k),
				).toBe(true);
			}
			previous = { s: row.sortKey, k: row.key };
			keys.push(row.key);
		}
		if (result.isDone) return keys;
		cursor = result.cursor;
		expect(cursor).not.toBeNull();
	}
	throw new Error("search did not terminate");
}

describe("substring semantics", () => {
	// Corpus modeled on SQLite fts5trigram.test block 1 (Latin + Thai),
	// with CJK rows for the case this component exists for.
	const corpus = [
		{ key: "latin", text: "abcdefghijklm", sortKey: 1 },
		{ key: "thai", text: "กรุงเทพมหานคร", sortKey: 2 },
		{ key: "cjk", text: "回程過磅費，司機墊付停車場費用", sortKey: 3 },
		{ key: "mixed", text: "TR-260814-002 三菱倉→深圳", sortKey: 4 },
	];

	test("interior substrings match; lookalikes do not", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		expect(await searchAll(t, "cdefg")).toEqual(["latin"]);
		expect(await searchAll(t, "abcdefghijklm")).toEqual(["latin"]);
		expect(await searchAll(t, "acdef")).toEqual([]);
		expect(await searchAll(t, "รุงเ")).toEqual(["thai"]);
		expect(await searchAll(t, "停車場")).toEqual(["cjk"]);
		expect(await searchAll(t, "停車場費")).toEqual(["cjk"]);
		expect(await searchAll(t, "停車費")).toEqual([]); // not contiguous in the text
	});

	test("two-codepoint CJK query (the pg_bigm case)", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		expect(await searchAll(t, "過磅")).toEqual(["cjk"]);
		expect(await searchAll(t, "深圳")).toEqual(["mixed"]);
	});

	test("single-codepoint query, including the final character", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		expect(await searchAll(t, "m")).toEqual(["latin"]); // final char: sentinel gram path
		expect(await searchAll(t, "圳")).toEqual(["mixed"]); // final char, CJK
		expect(await searchAll(t, "費")).toEqual(["cjk"]);
		expect(await searchAll(t, "z")).toEqual([]);
	});

	test("single-codepoint document", async () => {
		const t = initConvexTest();
		await seed(t, [{ key: "one", text: "薑", sortKey: 1 }]);
		expect(await searchAll(t, "薑")).toEqual(["one"]);
	});

	test("case-insensitive (fts5trigram LIKE '%cDef%' analog)", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		expect(await searchAll(t, "cDef")).toEqual(["latin"]);
		expect(await searchAll(t, "ABCDEFGHIJKLM")).toEqual(["latin"]);
		expect(await searchAll(t, "tr-260814")).toEqual(["mixed"]);
	});

	test("full-width query matches half-width text (NFKC width folding)", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		// Full-width letters, digits AND hyphen (U+FF0D) all fold to ASCII.
		expect(await searchAll(t, "ＴＲ－２６０８１４")).toEqual(["mixed"]);
		expect(await searchAll(t, "ＴＲ")).toEqual(["mixed"]);
	});

	test("whitespace is a codepoint like any other", async () => {
		const t = initConvexTest();
		await seed(t, [{ key: "s", text: "send request", sortKey: 1 }]);
		expect(await searchAll(t, "d re")).toEqual(["s"]);
		expect(await searchAll(t, "dre")).toEqual([]);
	});

	test("empty query returns nothing and terminates", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		expect(await searchAll(t, "")).toEqual([]);
	});

	test("combining-mark input form does not matter (fts5trigram2 block 1 analog)", async () => {
		const t = initConvexTest();
		await seed(t, [{ key: "d", text: "pin\u0303ata", sortKey: 1 }]); // decomposed n + combining tilde
		expect(await searchAll(t, "pi\u00f1a")).toEqual(["d"]); // precomposed query
	});
});

describe("filters", () => {
	test("exact-match filters combine with search across the whole index", async () => {
		const t = initConvexTest();
		await seed(t, [
			{ key: "a", text: "停車費用一", sortKey: 1, filters: { source: "driver", flagged: true } },
			{ key: "b", text: "停車費用二", sortKey: 2, filters: { source: "staff" } },
			{ key: "c", text: "過路費", sortKey: 3, filters: { source: "driver" } },
		]);
		expect(await searchAll(t, "停車", { filters: { source: "driver" } })).toEqual(["a"]);
		expect(await searchAll(t, "停車", { filters: { source: "staff" } })).toEqual(["b"]);
		expect(await searchAll(t, "停車", {})).toEqual(["b", "a"]);
		expect(await searchAll(t, "停車", { filters: { source: "driver", flagged: true } })).toEqual(["a"]);
		expect(await searchAll(t, "停車", { filters: { source: "driver", flagged: false } })).toEqual([]);
	});

	test("absent field matches nothing, not even null", async () => {
		const t = initConvexTest();
		await seed(t, [
			{ key: "a", text: "xyz", sortKey: 1, filters: { category: null } },
			{ key: "b", text: "xyz", sortKey: 2 },
		]);
		expect(await searchAll(t, "xyz", { filters: { category: null } })).toEqual(["a"]);
	});
});

describe("updates and removal", () => {
	test("set replaces the indexed text", async () => {
		const t = initConvexTest();
		await seed(t, [{ key: "a", text: "舊備註內容", sortKey: 1 }]);
		expect(await searchAll(t, "舊備")).toEqual(["a"]);
		await t.mutation(api.lib.set, { namespace: NS, key: "a", text: "新備註內容", sortKey: 1 });
		expect(await searchAll(t, "舊備")).toEqual([]);
		expect(await searchAll(t, "新備")).toEqual(["a"]);
		expect(await searchAll(t, "備註")).toEqual(["a"]);
	});

	test("sortKey change reorders results", async () => {
		const t = initConvexTest();
		await seed(t, [
			{ key: "a", text: "同文", sortKey: 1 },
			{ key: "b", text: "同文", sortKey: 2 },
		]);
		expect(await searchAll(t, "同文")).toEqual(["b", "a"]);
		await t.mutation(api.lib.set, { namespace: NS, key: "a", text: "同文", sortKey: 3 });
		expect(await searchAll(t, "同文")).toEqual(["a", "b"]);
	});

	test("remove drops the document", async () => {
		const t = initConvexTest();
		await seed(t, [
			{ key: "a", text: "香港仔", sortKey: 1 },
			{ key: "b", text: "香港站", sortKey: 2 },
		]);
		await t.mutation(api.lib.remove, { namespace: NS, key: "b" });
		expect(await searchAll(t, "香港")).toEqual(["a"]);
		// removing again is a no-op
		await t.mutation(api.lib.remove, { namespace: NS, key: "b" });
	});

	test("namespaces are isolated", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, { namespace: "other", key: "x", text: "香港", sortKey: 1 });
		expect(await searchAll(t, "香港")).toEqual([]);
	});
});

describe("pagination", () => {
	test("small pages cover the full result set without duplicates", async () => {
		const t = initConvexTest();
		const docs = Array.from({ length: 23 }, (_, i) => ({
			key: `k${String(i).padStart(2, "0")}`,
			text: `第${i}張停車小票`,
			sortKey: i,
		}));
		await seed(t, docs);
		const keys = await searchAll(t, "停車", { limit: 4 });
		expect(keys).toHaveLength(23);
		expect(new Set(keys).size).toBe(23);
		expect(keys[0]).toBe("k22");
		expect(keys[22]).toBe("k00");
	});

	test("sparse hits under a tiny budget: empty pages carry a cursor, nothing is lost", async () => {
		const t = initConvexTest();
		// 40 docs share the gram "停車" but only 3 pass the filter.
		const docs = Array.from({ length: 40 }, (_, i) => ({
			key: `k${String(i).padStart(2, "0")}`,
			text: "停車費",
			sortKey: i,
			filters: { rare: i % 13 === 0 },
		}));
		await seed(t, docs);
		const keys = await searchAll(t, "停車", { filters: { rare: true }, budget: 5, limit: 50 });
		expect(keys).toEqual(["k39", "k26", "k13", "k00"]);
	});
});

describe("limits", () => {
	// Distinct CJK codepoints so a 4096-codepoint text produces ~4096 distinct grams.
	function bigText(length: number): string {
		return Array.from({ length }, (_, i) => String.fromCodePoint(0x4e00 + (i % 20000))).join("");
	}

	test("a 4096-codepoint document indexes, searches, edits, and deletes", async () => {
		const t = initConvexTest();
		const text = bigText(4096);
		await t.mutation(api.lib.set, { namespace: NS, key: "big", text, sortKey: 1 });
		// deep interior substring
		const middle = Array.from(text).slice(2000, 2005).join("");
		expect(await searchAll(t, middle)).toEqual(["big"]);
		// the final codepoint (sentinel gram at maximum size)
		const lastChar = Array.from(text)[4095];
		expect((await searchAll(t, lastChar)).includes("big")).toBe(true);
		// a small edit is a gram diff, not a rebuild — and remains correct
		const edited = `${Array.from(text).slice(0, 4090).join("")}停車場費用又`;
		await t.mutation(api.lib.set, { namespace: NS, key: "big", text: edited, sortKey: 1 });
		expect(await searchAll(t, "停車場費用")).toEqual(["big"]);
		await t.mutation(api.lib.remove, { namespace: NS, key: "big" });
		expect(await searchAll(t, "停車場費用")).toEqual([]);
	});

	test("overflow truncates by default: beyond-limit text is unfindable but the doc still works", async () => {
		const t = initConvexTest();
		const text = bigText(4096) + "超出上限的尾巴";
		await t.mutation(api.lib.set, { namespace: NS, key: "big", text, sortKey: 1 });
		expect(await searchAll(t, "超出上限")).toEqual([]);
		const kept = Array.from(text).slice(4090, 4096).join("");
		expect(await searchAll(t, kept)).toEqual(["big"]);
	});

	test("onOverflow: 'error' throws", async () => {
		const t = initConvexTest();
		await expect(
			t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				text: bigText(4097),
				sortKey: 1,
				onOverflow: "error",
			}),
		).rejects.toThrow(/4096/);
	});

	test("empty text indexes as unfindable but get() still sees it", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, { namespace: NS, key: "e", text: "", sortKey: 1 });
		expect(await searchAll(t, "a")).toEqual([]);
		const doc = await t.query(api.lib.get, { namespace: NS, key: "e" });
		expect(doc).toEqual({ foldedText: "", sortKey: 1 });
	});
});

describe("clearNamespace", () => {
	test("clears in batches until the cursor is null", async () => {
		const t = initConvexTest();
		await seed(
			t,
			Array.from({ length: 30 }, (_, i) => ({
				key: `k${String(i).padStart(2, "0")}`,
				text: `第${i}張停車小票`,
				sortKey: i,
			})),
		);
		await t.mutation(api.lib.set, { namespace: "other", key: "x", text: "停車", sortKey: 1 });
		let cursor: string | null = null;
		for (let i = 0; i < 100; i++) {
			const result: { cursor: string | null } = await t.mutation(api.lib.clearNamespace, {
				namespace: NS,
				cursor,
			});
			cursor = result.cursor;
			if (cursor === null) break;
		}
		expect(cursor).toBeNull();
		expect(await searchAll(t, "停車")).toEqual([]);
		// other namespaces untouched
		const other = await t.query(api.lib.get, { namespace: "other", key: "x" });
		expect(other).not.toBeNull();
	});
});
