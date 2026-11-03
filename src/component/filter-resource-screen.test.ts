import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { gramFieldsOf, firstCodepoint } from "../shared/grams.js";

test.skipIf(!process.env.CIS_RESOURCE_OUT)(
	"dense gram with a rare result filter resource screen",
	{ timeout: 30000 },
	async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			for (let i = 0; i < 3000; i++) {
				const key = `f${String(i).padStart(4, "0")}`,
					fields = { text: "停車費" };
				await ctx.db.insert("docs", {
					namespace: "filter-screen",
					key,
					sortKey: i,
					fields,
					filters: { rare: i % 100 === 0 },
				});
				for (const [gram, tags] of gramFieldsOf(fields))
					await ctx.db.insert("postings", {
						namespace: "filter-screen",
						key,
						sortKey: i,
						gram,
						g1: firstCodepoint(gram),
						fields: tags,
					});
			}
		});
		const cost = {
			calls: 0,
			ranges: 0,
			rows: 0,
			bytes: 0,
			maxCallRanges: 0,
			maxCallRows: 0,
			hits: 0,
			done: false,
		};
		let cursor: string | null = null;
		const keys: string[] = [];
		for (let call = 0; call < 50 && !cost.done; call++)
			await t.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const r = await ctx.runQuery(api.lib.search, {
					namespace: "filter-screen",
					query: "停車",
					filters: { rare: true },
					limit: 50,
					cursor,
				});
				const after = await ctx.meta.getTransactionMetrics();
				const ranges = after.databaseQueries.used - before.databaseQueries.used;
				const rows = after.documentsRead.used - before.documentsRead.used;
				cost.calls++;
				cost.ranges += ranges;
				cost.rows += rows;
				cost.bytes += after.bytesRead.used - before.bytesRead.used;
				cost.maxCallRanges = Math.max(cost.maxCallRanges, ranges);
				cost.maxCallRows = Math.max(cost.maxCallRows, rows);
				keys.push(...r.page.map((hit) => hit.key));
				cursor = r.cursor;
				cost.done = r.isDone;
			});
		cost.hits = keys.length;
		expect(cost.done).toBe(true);
		expect(keys).toEqual(
			Array.from(
				{ length: 30 },
				(_, i) => `f${String((29 - i) * 100).padStart(4, "0")}`,
			),
		);
		expect(cost.maxCallRanges).toBeLessThanOrEqual(1024);
		expect(cost.maxCallRows).toBeLessThanOrEqual(8000);
		appendFileSync(
			process.env.CIS_RESOURCE_OUT!,
			JSON.stringify({ label: process.env.CIS_RESOURCE_LABEL, ...cost }) + "\n",
		);
	},
);
