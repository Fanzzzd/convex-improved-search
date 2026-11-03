import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { fold, firstCodepoint, gramFieldsOf } from "../shared/grams.js";

test.skipIf(!process.env.CIS_SHORT_OUT)(
	"sparse short-page I/O screen",
	async () => {
		const t = initConvexTest();
		const entries = Array.from({ length: 340 }, (_, i) => ({
			key: `dispatch-${String(i).padStart(6, "0")}`,
			sortKey: i + 1,
			fields: {
				route: fold(i % 17 === 0 ? `香港 route ${i}` : `Taipei route ${i}`),
				cargo: `tr-26-${i}`,
			},
		}));
		await t.run(async (ctx) => {
			for (const entry of entries) {
				await ctx.db.insert("docs", { namespace: "short-screen", ...entry });
				for (const [gram] of gramFieldsOf(entry.fields))
					await ctx.db.insert("postings", {
						namespace: "short-screen",
						key: entry.key,
						sortKey: entry.sortKey,
						gram,
						g1: firstCodepoint(gram),
					});
			}
		});
		for (const query of ["香港", "香"])
			for (const limit of [1, 2, 7, 16, 20, 31, 32]) {
				await t.run(async (ctx) => {
					const before = await ctx.meta.getTransactionMetrics();
					const page = await ctx.runQuery(api.lib.search, {
						namespace: "short-screen",
						query,
						fields: ["route"],
						limit,
						budget: 512,
					});
					const after = await ctx.meta.getTransactionMetrics();
					expect(page.page.map((hit) => hit.key)).toEqual(
						entries
							.toReversed()
							.filter((entry) => entry.fields.route.includes(query))
							.slice(0, limit)
							.map((entry) => entry.key),
					);
					expect(
						page.page.every(
							(hit) => JSON.stringify(hit.matchedFields) === '["route"]',
						),
					).toBe(true);
					appendFileSync(
						process.env.CIS_SHORT_OUT!,
						JSON.stringify({
							query,
							limit,
							ranges: after.databaseQueries.used - before.databaseQueries.used,
							rows: after.documentsRead.used - before.documentsRead.used,
							bytes: after.bytesRead.used - before.bytesRead.used,
							hits: page.page.length,
							done: page.isDone,
						}) + "\n",
					);
				});
			}
	},
);
