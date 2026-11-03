import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { firstCodepoint, fold, gramFieldsOf } from "../shared/grams.js";

const NS = "bench";
test.skipIf(!process.env.CIS_SCREEN_OUT)(
	"W1 and dense first-page screen",
	{ timeout: 300000 },
	async () => {
		const entries: {
			key: string;
			sortKey: number;
			fields: { no: string; memo: string };
		}[] = [];
		for (let day = 0; day < 365; day++) {
			const date = new Date(Date.UTC(2026, 0, 1) + day * 86400000);
			const ymd = `26${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
			for (let n = 1; n <= 10; n++) {
				const sortKey = entries.length + 1;
				const no = `TR-${ymd}-${String(n).padStart(3, "0")}`;
				entries.push({
					key: no,
					sortKey,
					fields: {
						no: fold(no),
						memo: fold(
							sortKey % 97 === 0
								? "補單，原單 TR-260720-006"
								: "司機墊付停車費",
						),
					},
				});
			}
		}
		const t = initConvexTest();
		for (let start = 0; start < entries.length; start += 400)
			await t.run(async (ctx) => {
				for (const entry of entries.slice(start, start + 400)) {
					await ctx.db.insert("docs", { namespace: NS, ...entry });
					for (const [gram, fields] of gramFieldsOf(entry.fields))
						await ctx.db.insert("postings", {
							namespace: NS,
							key: entry.key,
							sortKey: entry.sortKey,
							gram,
							g1: firstCodepoint(gram),
							fields,
						});
				}
			});
		for (const [workload, query, drain] of [
			["W1 TR-260720-006 drain", "TR-260720-006", true],
			["W3 停車 first page", "停車", false],
			["W4 0 first page", "0", false],
		] as const) {
			const expected = entries
				.toReversed()
				.filter((e) =>
					Object.values(e.fields).some((text) => text.includes(fold(query))),
				)
				.map((e) => e.key);
			let cursor: string | null = null,
				done = false;
			const keys: string[] = [];
			const cost = {
				calls: 0,
				ranges: 0,
				rows: 0,
				bytes: 0,
				maxCallRanges: 0,
				maxCallRows: 0,
				maxCallBytes: 0,
				hits: 0,
				done: false,
			};
			for (let call = 0; call < 2000; call++) {
				await t.run(async (ctx) => {
					const b = await ctx.meta.getTransactionMetrics();
					const result = await ctx.runQuery(api.lib.search, {
						namespace: NS,
						query,
						limit: 50,
						cursor,
					});
					const a = await ctx.meta.getTransactionMetrics();
					const ranges = a.databaseQueries.used - b.databaseQueries.used;
					const rows = a.documentsRead.used - b.documentsRead.used;
					const bytes = a.bytesRead.used - b.bytesRead.used;
					cost.calls++;
					cost.ranges += ranges;
					cost.rows += rows;
					cost.bytes += bytes;
					cost.maxCallRanges = Math.max(cost.maxCallRanges, ranges);
					cost.maxCallRows = Math.max(cost.maxCallRows, rows);
					cost.maxCallBytes = Math.max(cost.maxCallBytes, bytes);
					keys.push(...result.page.map((hit) => hit.key));
					cursor = result.cursor;
					done = result.isDone;
				});
				if (done || !drain) break;
			}
			expect(keys).toEqual(drain ? expected : expected.slice(0, 50));
			if (drain) expect(done).toBe(true);
			cost.hits = keys.length;
			cost.done = done;
			appendFileSync(
				process.env.CIS_SCREEN_OUT!,
				JSON.stringify({ workload, ...cost }) + "\n",
			);
		}
	},
);
