import { expect, test } from "vitest";
import { compareValues } from "convex/values";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { firstCodepoint, fold, gramFieldsOf } from "../shared/grams.js";

// Tests the public search interface across folded query shapes, not the
// selector's internals. One-gram repetitions must still verify the full text.
test("query-shape routing preserves exact paginated results", async () => {
	const t = initConvexTest();
	const texts = [
		"ab",
		"abc",
		"ababa",
		"aaaa",
		"aab",
		"香港",
		"香",
		"😀ab",
		"😀a",
		"Å abc",
		"ＡＢＣ",
		"none",
	];
	const entries = Array.from({ length: 72 }, (_, i) => ({
		key: `${i % 2 === 0 ? "" : "\u{10000}"}${String(i).padStart(3, "0")}`,
		sortKey: i < 24 ? 0 : i < 48 ? -0 : -1,
		fields: {
			a: fold(texts[i % texts.length]),
			b: fold(texts[(i + 3) % texts.length]),
		},
	}));
	await t.run(async (ctx) => {
		for (const entry of entries) {
			await ctx.db.insert("docs", { namespace: "route-regression", ...entry });
			for (const [gram, fields] of gramFieldsOf(entry.fields))
				await ctx.db.insert("postings", {
					namespace: "route-regression",
					key: entry.key,
					sortKey: entry.sortKey,
					gram,
					g1: firstCodepoint(gram),
					fields,
				});
		}
	});
	const queries = [
		"a",
		"ab",
		"abc",
		"aaaa",
		"ababa",
		"香",
		"香港",
		"😀",
		"😀a",
		"😀ab",
		"Å",
		"ＡＢＣ",
	];
	for (const query of queries)
		for (const limit of [1, 7, 50]) {
			const fields = limit === 7 ? ["b"] : undefined;
			const expected = entries
				.flatMap((entry) => {
					const matchedFields = Object.entries(entry.fields)
						.filter(
							([name, text]) =>
								(!fields || fields.includes(name)) &&
								text.includes(fold(query)),
						)
						.map(([name]) => name)
						.sort();
					return matchedFields.length
						? [{ key: entry.key, sortKey: entry.sortKey, matchedFields }]
						: [];
				})
				.sort(
					(a, b) =>
						compareValues(b.sortKey, a.sortKey) || compareValues(b.key, a.key),
				);
			const actual: {
				key: string;
				sortKey: number;
				matchedFields: string[];
			}[] = [];
			let cursor: string | null = null,
				done = false;
			for (let call = 0; call < 200 && !done; call++) {
				const page = await t.run(async (ctx) =>
					ctx.runQuery(api.lib.search, {
						namespace: "route-regression",
						query,
						fields,
						limit,
						budget: Math.max(limit, 9),
						cursor,
					}),
				);
				actual.push(
					...page.page.map((hit) => ({
						...hit,
						matchedFields: [...hit.matchedFields].sort(),
					})),
				);
				if (!page.isDone) {
					expect(page.cursor).not.toBeNull();
					expect(page.cursor).not.toBe(cursor);
				}
				cursor = page.cursor;
				done = page.isDone;
			}
			expect(done, `${query} limit ${limit}`).toBe(true);
			expect(actual, `${query} limit ${limit}`).toEqual(expected);
		}
});
