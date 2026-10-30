/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { TestConvex } from "convex-test";
import type schema from "./schema.js";

const NS = "test";

type T = TestConvex<typeof schema>;

/** Single-text entries live under the field name "text" (the client's sugar, inlined). */
const asFields = (text: string) => [{ name: "text", value: text }];

async function seed(
	t: T,
	docs: {
		key: string;
		fields: { name: string; value: string }[];
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
		{ key: "latin", fields: asFields("abcdefghijklm"), sortKey: 1 },
		{ key: "thai", fields: asFields("กรุงเทพมหานคร"), sortKey: 2 },
		{
			key: "cjk",
			fields: asFields("回程過磅費，司機墊付停車場費用"),
			sortKey: 3,
		},
		{ key: "mixed", fields: asFields("TR-260814-002 三菱倉→深圳"), sortKey: 4 },
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
		await seed(t, [{ key: "one", fields: asFields("薑"), sortKey: 1 }]);
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
		await seed(t, [{ key: "s", fields: asFields("send request"), sortKey: 1 }]);
		expect(await searchAll(t, "d re")).toEqual(["s"]);
		expect(await searchAll(t, "dre")).toEqual([]);
	});

	test("empty query returns nothing and terminates", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		expect(await searchAll(t, "")).toEqual([]);
	});

	test("a query longer than any indexed field terminates without scanning", async () => {
		const t = initConvexTest();
		await seed(t, corpus);
		expect(await searchAll(t, "界".repeat(4097))).toEqual([]);
	});

	test("combining-mark input form does not matter (fts5trigram2 block 1 analog)", async () => {
		const t = initConvexTest();
		await seed(t, [{ key: "d", fields: asFields("pin\u0303ata"), sortKey: 1 }]); // decomposed n + combining tilde
		expect(await searchAll(t, "pi\u00f1a")).toEqual(["d"]); // precomposed query
	});
});

describe("fields", () => {
	test("matches never span a field boundary; matchedFields reports the hits", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "r",
			fields: [
				{ name: "note", value: "司機墊付停車場費" },
				{ name: "cargo", value: "玻璃面板 TR-999 深水埗→葵涌" },
			],
			sortKey: 1,
		});
		// Contiguous inside one field: matches, and names that field.
		const noteHit = await t.query(api.lib.search, {
			namespace: NS,
			query: "停車場",
		});
		expect(noteHit.page).toEqual([
			{ key: "r", sortKey: 1, matchedFields: ["note"] },
		]);
		const cargoHit = await t.query(api.lib.search, {
			namespace: NS,
			query: "tr-999",
		});
		expect(cargoHit.page.map((row) => row.matchedFields)).toEqual([["cargo"]]);
		// "費" ends note, "玻" starts cargo — adjacent across the boundary must not match.
		expect(await searchAll(t, "費玻")).toEqual([]);
		// A query hitting both fields reports both.
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "r",
			fields: [
				{ name: "note", value: "同一個詞" },
				{ name: "cargo", value: "同一個詞" },
			],
			sortKey: 1,
		});
		const dual = await t.query(api.lib.search, {
			namespace: NS,
			query: "同一",
		});
		expect(dual.page.map((row) => [...row.matchedFields].sort())).toEqual([
			["cargo", "note"],
		]);
	});

	test("re-set can change the field layout; stale-field text is unfindable at once", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "r",
			fields: [{ name: "note", value: "舊備註" }],
			sortKey: 1,
		});
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "r",
			fields: [{ name: "cargo", value: "新貨物" }],
			sortKey: 1,
		});
		expect(await searchAll(t, "舊備")).toEqual([]);
		const hit = await t.query(api.lib.search, { namespace: NS, query: "新貨" });
		expect(hit.page.map((row) => row.matchedFields)).toEqual([["cargo"]]);
	});

	test("fields restricts which Fields can match and which are reported", async () => {
		const t = initConvexTest();
		await seed(t, [
			{
				key: "own",
				fields: [
					{ name: "no", value: "TR-1" },
					{ name: "memo", value: "停車" },
				],
				sortKey: 3,
			},
			{
				key: "cites",
				fields: [
					{ name: "no", value: "TR-2" },
					{ name: "memo", value: "原單 TR-1" },
				],
				sortKey: 2,
			},
			{
				key: "both",
				fields: [
					{ name: "no", value: "TR-1" },
					{ name: "memo", value: "TR-1 補" },
				],
				sortKey: 1,
			},
		]);
		const only = async (fields: string[]) =>
			(
				await t.query(api.lib.search, { namespace: NS, query: "tr-1", fields })
			).page.map((row) => [row.key, [...row.matchedFields].sort()]);
		expect(await only(["no"])).toEqual([
			["own", ["no"]],
			["both", ["no"]],
		]);
		expect(await only(["memo"])).toEqual([
			["cites", ["memo"]],
			["both", ["memo"]],
		]);
		expect(await only(["no", "memo", "absent"])).toEqual([
			["own", ["no"]],
			["cites", ["memo"]],
			["both", ["memo", "no"]],
		]);
		const none = await t.query(api.lib.search, {
			namespace: NS,
			query: "tr-1",
			fields: [],
		});
		expect(none).toEqual({
			page: [],
			cursor: null,
			isDone: true,
			scanned: 0,
			verified: 0,
		});
	});

	test("duplicate field names are refused", async () => {
		const t = initConvexTest();
		await expect(
			t.mutation(api.lib.set, {
				namespace: NS,
				key: "r",
				fields: [
					{ name: "note", value: "一" },
					{ name: "note", value: "二" },
				],
				sortKey: 1,
			}),
		).rejects.toThrow(/Duplicate field/);
	});

	test("the codepoint budget is shared across fields, spent in field order", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "big",
			fields: [
				{ name: "head", value: bigText(4092) },
				{ name: "tail", value: "尾部字段內容" },
			],
			sortKey: 1,
		});
		// head fits fully; tail got the remaining 4 codepoints and was cut mid-way.
		expect(await searchAll(t, "尾部字段內容")).toEqual([]);
		expect((await searchAll(t, "尾部")).includes("big")).toBe(true);
		// error mode refuses instead of truncating.
		await expect(
			t.mutation(api.lib.set, {
				namespace: NS,
				key: "big2",
				fields: [
					{ name: "head", value: bigText(4092) },
					{ name: "tail", value: "尾部字段內容" },
				],
				sortKey: 1,
				onOverflow: "error",
			}),
		).rejects.toThrow(/4096/);
	}, 60_000);
});

describe("filters", () => {
	test("exact-match filters combine with search across the whole index", async () => {
		const t = initConvexTest();
		await seed(t, [
			{
				key: "a",
				fields: asFields("停車費用一"),
				sortKey: 1,
				filters: { source: "driver", flagged: true },
			},
			{
				key: "b",
				fields: asFields("停車費用二"),
				sortKey: 2,
				filters: { source: "staff" },
			},
			{
				key: "c",
				fields: asFields("過路費"),
				sortKey: 3,
				filters: { source: "driver" },
			},
		]);
		expect(
			await searchAll(t, "停車", { filters: { source: "driver" } }),
		).toEqual(["a"]);
		expect(
			await searchAll(t, "停車", { filters: { source: "staff" } }),
		).toEqual(["b"]);
		expect(await searchAll(t, "停車", {})).toEqual(["b", "a"]);
		expect(
			await searchAll(t, "停車", {
				filters: { source: "driver", flagged: true },
			}),
		).toEqual(["a"]);
		expect(
			await searchAll(t, "停車", {
				filters: { source: "driver", flagged: false },
			}),
		).toEqual([]);
	});

	test("absent field matches nothing, not even null", async () => {
		const t = initConvexTest();
		await seed(t, [
			{
				key: "a",
				fields: asFields("xyz"),
				sortKey: 1,
				filters: { category: null },
			},
			{ key: "b", fields: asFields("xyz"), sortKey: 2 },
		]);
		expect(await searchAll(t, "xyz", { filters: { category: null } })).toEqual([
			"a",
		]);
	});

	test("rejects non-finite numeric filters on writes and reads", async () => {
		const t = initConvexTest();
		await expect(
			t.mutation(api.lib.set, {
				namespace: NS,
				key: "bad-filter",
				fields: asFields("停車"),
				sortKey: 1,
				filters: { score: Number.NaN },
			}),
		).rejects.toThrow(/Filter "score" must be a finite number/);
		await expect(
			t.query(api.lib.search, {
				namespace: NS,
				query: "停車",
				filters: { score: Number.POSITIVE_INFINITY },
			}),
		).rejects.toThrow(/Filter "score" must be a finite number/);
	});
});

describe("numeric bounds", () => {
	test.each([
		["limit", { limit: Number.NaN }],
		["budget", { budget: Number.POSITIVE_INFINITY }],
	] as const)("rejects a non-finite %s", async (_name, controls) => {
		const t = initConvexTest();
		await expect(
			t.query(api.lib.search, { namespace: NS, query: "停車", ...controls }),
		).rejects.toThrow(/must be a finite number/);
	});

	test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects non-finite sortKey %s before writing",
		async (sortKey) => {
			const t = initConvexTest();
			await expect(
				t.mutation(api.lib.set, {
					namespace: NS,
					key: "bad-sort",
					fields: asFields("停車"),
					sortKey,
				}),
			).rejects.toThrow(/sortKey must be a finite number/);
		},
	);
});

describe("updates and removal", () => {
	test("set replaces the indexed text", async () => {
		const t = initConvexTest();
		await seed(t, [{ key: "a", fields: asFields("舊備註內容"), sortKey: 1 }]);
		expect(await searchAll(t, "舊備")).toEqual(["a"]);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: asFields("新備註內容"),
			sortKey: 1,
		});
		expect(await searchAll(t, "舊備")).toEqual([]);
		expect(await searchAll(t, "新備")).toEqual(["a"]);
		expect(await searchAll(t, "備註")).toEqual(["a"]);
	});

	test("sortKey change reorders results", async () => {
		const t = initConvexTest();
		await seed(t, [
			{ key: "a", fields: asFields("同文"), sortKey: 1 },
			{ key: "b", fields: asFields("同文"), sortKey: 2 },
		]);
		expect(await searchAll(t, "同文")).toEqual(["b", "a"]);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: asFields("同文"),
			sortKey: 3,
		});
		expect(await searchAll(t, "同文")).toEqual(["a", "b"]);
	});

	test("a filter-only or no-op re-set leaves the postings alone", async () => {
		const t = initConvexTest();
		await seed(t, [
			{
				key: "a",
				fields: asFields("過磅單"),
				sortKey: 1,
				filters: { site: "x" },
			},
		]);
		const postingRows = () =>
			t.run(async (ctx) =>
				(await ctx.db.query("postings").collect())
					.map((p) => `${p._id}:${p.sortKey}`)
					.sort(),
			);
		const before = await postingRows();
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: asFields("過磅單"),
			sortKey: 1,
			filters: { site: "y" },
		});
		expect(await searchAll(t, "過磅", { filters: { site: "x" } })).toEqual([]);
		expect(await searchAll(t, "過磅", { filters: { site: "y" } })).toEqual([
			"a",
		]);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: asFields("過磅單"),
			sortKey: 1,
			filters: { site: "y" },
		});
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: asFields("過磅單"),
			sortKey: 1,
		});
		expect(await searchAll(t, "過磅", { filters: { site: "y" } })).toEqual([]);
		expect(await searchAll(t, "過磅")).toEqual(["a"]);
		expect(await postingRows()).toEqual(before);
	});

	test("an unchanged re-set reads one posting, not all (a missing row stays missing)", async () => {
		const t = initConvexTest();
		await seed(t, [{ key: "a", fields: asFields("過磅單"), sortKey: 1 }]);
		const countPostings = () =>
			t.run(async (ctx) => (await ctx.db.query("postings").collect()).length);
		const full = await countPostings();
		await t.run(async (ctx) => {
			const row = await ctx.db.query("postings").first();
			if (row !== null) await ctx.db.delete("postings", row._id);
		});
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: asFields("過磅單"),
			sortKey: 1,
			filters: { site: "x" },
		});
		expect(await countPostings()).toBe(full - 1);
		// A text change runs the full diff again and repairs the gap.
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: asFields("過磅單!"),
			sortKey: 1,
		});
		expect(await countPostings()).toBe(full + 1);
	});

	test("postings carry the Fields that hold their gram; set retags them, and re-setting a pre-0.5.0 entry tags it", async () => {
		const t = initConvexTest();
		// Grams end in the U+0001 sentinel, which Convex refuses as an object key.
		const tags = async () =>
			Object.fromEntries(
				await t.run(async (ctx) =>
					(await ctx.db.query("postings").collect()).map((p) => [
						p.gram.replace("\u0001", "$"),
						p.fields?.join(",") ?? "-",
					]),
				),
			);
		const fields = (no: string, memo: string) => [
			{ name: "no", value: no },
			{ name: "memo", value: memo },
		];
		await seed(t, [{ key: "a", fields: fields("ab", "bc"), sortKey: 1 }]);
		expect(await tags()).toEqual({
			ab: "no",
			b$: "no",
			bc: "memo",
			c$: "memo",
		});
		// "ab" now also lies in memo: its row is patched, not rewritten.
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: fields("ab", "abc"),
			sortKey: 1,
		});
		expect((await tags()).ab).toBe("memo,no");
		expect(
			(
				await t.query(api.lib.search, {
					namespace: NS,
					query: "ab",
					fields: ["memo"],
				})
			).page,
		).toEqual([{ key: "a", sortKey: 1, matchedFields: ["memo"] }]);
		// Rows written before 0.5.0 have no tag; an unchanged re-set (the backfill) adds it.
		await t.run(async (ctx) => {
			for (const p of await ctx.db.query("postings").collect()) {
				await ctx.db.replace("postings", p._id, {
					namespace: p.namespace,
					gram: p.gram,
					g1: p.g1,
					key: p.key,
					sortKey: p.sortKey,
				});
			}
		});
		expect(
			(
				await t.query(api.lib.search, {
					namespace: NS,
					query: "bc",
					fields: ["memo"],
				})
			).page,
		).toEqual([{ key: "a", sortKey: 1, matchedFields: ["memo"] }]);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: fields("ab", "abc"),
			sortKey: 1,
		});
		expect((await tags()).ab).toBe("memo,no");
	});

	test("renaming a field with the same text is not a no-op", async () => {
		const t = initConvexTest();
		await seed(t, [
			{ key: "a", fields: [{ name: "title", value: "停車" }], sortKey: 1 },
		]);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "a",
			fields: [{ name: "body", value: "停車" }],
			sortKey: 1,
		});
		const result = await t.query(api.lib.search, {
			namespace: NS,
			query: "停車",
		});
		expect(result.page).toEqual([
			{ key: "a", sortKey: 1, matchedFields: ["body"] },
		]);
	});

	test("remove drops the document", async () => {
		const t = initConvexTest();
		await seed(t, [
			{ key: "a", fields: asFields("香港仔"), sortKey: 1 },
			{ key: "b", fields: asFields("香港站"), sortKey: 2 },
		]);
		await t.mutation(api.lib.remove, { namespace: NS, key: "b" });
		expect(await searchAll(t, "香港")).toEqual(["a"]);
		// removing again is a no-op
		await t.mutation(api.lib.remove, { namespace: NS, key: "b" });
	});

	test("namespaces are isolated", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, {
			namespace: "other",
			key: "x",
			fields: asFields("香港"),
			sortKey: 1,
		});
		expect(await searchAll(t, "香港")).toEqual([]);
	});
});

describe("pagination", () => {
	test("small pages cover the full result set without duplicates", async () => {
		const t = initConvexTest();
		const docs = Array.from({ length: 23 }, (_, i) => ({
			key: `k${String(i).padStart(2, "0")}`,
			fields: asFields(`第${i}張停車小票`),
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
			fields: asFields("停車費"),
			sortKey: i,
			filters: { rare: i % 13 === 0 },
		}));
		await seed(t, docs);
		const keys = await searchAll(t, "停車", {
			filters: { rare: true },
			budget: 5,
			limit: 50,
		});
		expect(keys).toEqual(["k39", "k26", "k13", "k00"]);
	});
});

// Distinct CJK codepoints so a 4096-codepoint text produces ~4096 distinct grams.
function bigText(length: number): string {
	return Array.from({ length }, (_, i) =>
		String.fromCodePoint(0x4e00 + (i % 20000)),
	).join("");
}

describe("limits", () => {
	test("a 4096-codepoint document indexes, searches, edits, and deletes", async () => {
		const t = initConvexTest();
		const text = bigText(4096);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "big",
			fields: asFields(text),
			sortKey: 1,
		});
		// deep interior substring
		const middle = Array.from(text).slice(2000, 2005).join("");
		expect(await searchAll(t, middle)).toEqual(["big"]);
		// the final codepoint (sentinel gram at maximum size)
		const lastChar = Array.from(text)[4095];
		expect((await searchAll(t, lastChar)).includes("big")).toBe(true);
		// a small edit is a gram diff, not a rebuild — and remains correct
		const edited = `${Array.from(text).slice(0, 4090).join("")}停車場費用又`;
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "big",
			fields: asFields(edited),
			sortKey: 1,
		});
		expect(await searchAll(t, "停車場費用")).toEqual(["big"]);
		await t.mutation(api.lib.remove, { namespace: NS, key: "big" });
		expect(await searchAll(t, "停車場費用")).toEqual([]);
	}, 60_000);

	test("overflow truncates by default: beyond-limit text is unfindable but the doc still works", async () => {
		const t = initConvexTest();
		const text = bigText(4096) + "超出上限的尾巴";
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "big",
			fields: asFields(text),
			sortKey: 1,
		});
		expect(await searchAll(t, "超出上限")).toEqual([]);
		const kept = Array.from(text).slice(4090, 4096).join("");
		expect(await searchAll(t, kept)).toEqual(["big"]);
	}, 60_000);

	test("onOverflow: 'error' throws", async () => {
		const t = initConvexTest();
		await expect(
			t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				fields: asFields(bigText(4097)),
				sortKey: 1,
				onOverflow: "error",
			}),
		).rejects.toThrow(/4096/);
	}, 60_000);

	test("empty text indexes as unfindable but get() still sees it", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "e",
			fields: asFields(""),
			sortKey: 1,
		});
		expect(await searchAll(t, "a")).toEqual([]);
		const doc = await t.query(api.lib.get, { namespace: NS, key: "e" });
		expect(doc).toEqual({ fields: { text: "" }, sortKey: 1 });
	});
});

describe("deferred reaping", () => {
	// Convex counts deletes as reads (4096/transaction), so a max-size doc's
	// postings cannot die synchronously; correctness must not depend on them.
	test("removing a max-size document hides it immediately, postings die async", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const text = bigText(4096);
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				fields: asFields(text),
				sortKey: 1,
			});
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "small",
				fields: asFields("停車場"),
				sortKey: 2,
			});
			await t.mutation(api.lib.remove, { namespace: NS, key: "big" });
			// Unfindable the moment remove() returns, orphaned postings or not.
			const middle = Array.from(text).slice(2000, 2005).join("");
			expect(await searchAll(t, middle)).toEqual([]);
			expect(await searchAll(t, "停車")).toEqual(["small"]);
			const lingering = await t.run(async (ctx) => {
				const rows = await ctx.db
					.query("postings")
					.withIndex("by_ns_key", (q) => q.eq("namespace", NS).eq("key", "big"))
					.collect();
				return rows.length;
			});
			expect(lingering).toBeGreaterThan(0);
			// The reaper chain (self-rescheduling past REAP_BATCH) drains them.
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			const after = await t.run(async (ctx) => {
				const rows = await ctx.db
					.query("postings")
					.withIndex("by_ns_key", (q) => q.eq("namespace", NS).eq("key", "big"))
					.collect();
				return rows.length;
			});
			expect(after).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	}, 60_000);

	test("renaming the Field of a max-size text retags in the reaper; search ignores the stale tags meanwhile", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const text = bigText(4096);
			const middle = Array.from(text).slice(2000, 2005).join("");
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				fields: [{ name: "title", value: text }],
				sortKey: 1,
			});
			// 4096 tag-only patches exceed the inline limit: no throw, a retag mark instead.
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				fields: [{ name: "body", value: text }],
				sortKey: 1,
			});
			const marks = () =>
				t.run(
					async (ctx) => (await ctx.db.query("retagging").collect()).length,
				);
			expect(await marks()).toBe(1);
			const hit = [{ key: "big", sortKey: 1, matchedFields: ["body"] }];
			expect(
				(
					await t.query(api.lib.search, {
						namespace: NS,
						query: middle,
						fields: ["body"],
					})
				).page,
			).toEqual(hit);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await marks()).toBe(0);
			const stale = await t.run(
				async (ctx) =>
					(await ctx.db.query("postings").collect()).filter(
						(p) => p.fields?.join() !== "body",
					).length,
			);
			expect(stale).toBe(0);
			expect(
				(
					await t.query(api.lib.search, {
						namespace: NS,
						query: middle,
						fields: ["body"],
					})
				).page,
			).toEqual(hit);
		} finally {
			vi.useRealTimers();
		}
	}, 60_000);

	test("shrinking a huge text: old substrings unfindable at once, postings reaped to the new gram set", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const text = bigText(4096);
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				fields: asFields(text),
				sortKey: 1,
			});
			const middle = Array.from(text).slice(2000, 2005).join("");
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				fields: asFields("停車場"),
				sortKey: 1,
			});
			expect(await searchAll(t, middle)).toEqual([]);
			expect(await searchAll(t, "停車場")).toEqual(["big"]);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			const grams = await t.run(async (ctx) => {
				const rows = await ctx.db
					.query("postings")
					.withIndex("by_ns_key", (q) => q.eq("namespace", NS).eq("key", "big"))
					.collect();
				return rows.map((r) => r.gram).sort();
			});
			// exactly 停車, 車場, 場<sentinel>
			expect(grams).toEqual(["停車", "場", "車場"].sort());
			expect(await searchAll(t, "停車場")).toEqual(["big"]);
		} finally {
			vi.useRealTimers();
		}
	}, 60_000);

	test("sortKey change on a multi-thousand-gram text is refused; text edits are not", async () => {
		const t = initConvexTest();
		const text = bigText(4096);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "big",
			fields: asFields(text),
			sortKey: 1,
		});
		await expect(
			t.mutation(api.lib.set, {
				namespace: NS,
				key: "big",
				fields: asFields(text),
				sortKey: 2,
			}),
		).rejects.toThrow(/sortKey/);
		// Same sortKey, edited text: fine — this is the supported shape.
		const edited = `${Array.from(text).slice(0, 4090).join("")}停車場費用又`;
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "big",
			fields: asFields(edited),
			sortKey: 1,
		});
		expect(await searchAll(t, "停車場費用")).toEqual(["big"]);
	}, 60_000);
});

describe("clearNamespace", () => {
	test("a namespace holding a max-size document clears across batches", async () => {
		const t = initConvexTest();
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "big",
			fields: asFields(bigText(4096)),
			sortKey: 1,
		});
		let cursor: string | null = null;
		let calls = 0;
		do {
			const result: { cursor: string | null } = await t.mutation(
				api.lib.clearNamespace,
				{
					namespace: NS,
					cursor,
				},
			);
			cursor = result.cursor;
			calls += 1;
		} while (cursor !== null && calls < 100);
		expect(cursor).toBeNull();
		expect(calls).toBeGreaterThan(1); // ~4096 postings > one REAP_BATCH
		const remaining = await t.run(async (ctx) => {
			const docs = await ctx.db.query("docs").collect();
			const postings = await ctx.db.query("postings").collect();
			return docs.length + postings.length;
		});
		expect(remaining).toBe(0);
	}, 60_000);

	test("clears in batches until the cursor is null", async () => {
		const t = initConvexTest();
		await seed(
			t,
			Array.from({ length: 30 }, (_, i) => ({
				key: `k${String(i).padStart(2, "0")}`,
				fields: asFields(`第${i}張停車小票`),
				sortKey: i,
			})),
		);
		await t.mutation(api.lib.set, {
			namespace: "other",
			key: "x",
			fields: asFields("停車"),
			sortKey: 1,
		});
		let cursor: string | null = null;
		for (let i = 0; i < 100; i++) {
			const result: { cursor: string | null } = await t.mutation(
				api.lib.clearNamespace,
				{
					namespace: NS,
					cursor,
				},
			);
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

describe("namespaceBefore", () => {
	test("steps down through the namespaces under a prefix that hold Entries", async () => {
		const t = initConvexTest();
		for (const namespace of [
			"r/2026Q1",
			"r/2026Q3",
			"r/2025Q4",
			"r",
			"rx/2026Q4",
			"s/2027Q1",
		]) {
			for (const key of ["a", "b", "c"]) {
				await t.mutation(api.lib.set, {
					namespace,
					key,
					fields: asFields("停車"),
					sortKey: 1,
				});
			}
		}
		await t.mutation(api.lib.remove, { namespace: "r/2025Q4", key: "a" });
		await t.mutation(api.lib.set, {
			namespace: "r/2024Q1",
			key: "gone",
			fields: asFields("x"),
			sortKey: 1,
		});
		await t.mutation(api.lib.remove, { namespace: "r/2024Q1", key: "gone" });

		const seen: string[] = [];
		let before: string | undefined;
		for (;;) {
			const namespace = await t.query(api.lib.namespaceBefore, {
				prefix: "r/",
				before,
			});
			if (namespace === null) break;
			seen.push(namespace);
			before = namespace;
		}
		// An emptied namespace drops out; "r", "rx/…" and "s/…" never match.
		expect(seen).toEqual(["r/2026Q3", "r/2026Q1", "r/2025Q4"]);
	});
});
