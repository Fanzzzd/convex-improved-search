/// <reference types="vite/client" />
/**
 * Scale series, same harness rules as cost.bench.test.ts: one namespace of
 * `TR-YYMMDD-NNN` numbers, 100 a day (fields `no` and `memo`; every 997th
 * memo cites `TR-260720-006`), at growing N. Per-call cost and cost per hit
 * must stay flat as N grows: every stream seeks by index position, so
 * nothing in the plan should read in proportion to the namespace.
 *  exact:  `TR-260720-006` drained (hits grow with N only through memos).
 *  prefix: `TR-2607` first page (dense).
 *  cjk:    `停車` first page (in most memos).
 *  none:   `07-2607` drained: no hits, yet every gram is common (`7-` in
 *          1 of 10 numbers). No bigram plan can skip the candidates, so
 *          this one grows with N; each page must stay bounded.
 */
import { appendFileSync } from "node:fs";
import { test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { firstCodepoint, fold, gramFieldsOf } from "./grams.js";

const NS = "bench";
type T = ReturnType<typeof initConvexTest>;
type Page = { page: unknown[]; cursor: string | null; isDone: boolean };

async function seed(t: T, n: number) {
	const day0 = Date.UTC(2026, 6, 20);
	const perTransaction = 2000;
	for (let start = 0; start < n; start += perTransaction) {
		await t.run(async (ctx) => {
			for (let i = start; i < Math.min(n, start + perTransaction); i++) {
				// The newest numbers first in sortKey order, back from 2026-07-20.
				const date = new Date(day0 - Math.floor(i / 100) * 86_400_000);
				const ymd = `${String(date.getUTCFullYear()).slice(2)}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
				const no = `TR-${ymd}-${String((i % 100) + 1).padStart(3, "0")}`;
				const fields = {
					no: fold(no),
					memo: fold(
						i % 997 === 0 ? "補單，原單 TR-260720-006" : "司機墊付停車費",
					),
				};
				const sortKey = n - i;
				await ctx.db.insert("docs", {
					namespace: NS,
					key: no,
					fields,
					sortKey,
				});
				for (const [gram, tag] of gramFieldsOf(fields)) {
					await ctx.db.insert("postings", {
						namespace: NS,
						key: no,
						gram,
						g1: firstCodepoint(gram),
						sortKey,
						fields: tag,
					});
				}
			}
		});
	}
}

async function drain(t: T, query: string, maxCalls: number) {
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
	let cursor: string | null = null;
	for (let i = 0; i < maxCalls && !cost.done; i++) {
		await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const page: Page = await ctx.runQuery(api.lib.search, {
				namespace: NS,
				query,
				limit: 50,
				cursor,
			});
			const after = await ctx.meta.getTransactionMetrics();
			const ranges = after.databaseQueries.used - before.databaseQueries.used;
			const rows = after.documentsRead.used - before.documentsRead.used;
			const bytes = after.bytesRead.used - before.bytesRead.used;
			cost.calls += 1;
			cost.ranges += ranges;
			cost.rows += rows;
			cost.bytes += bytes;
			cost.maxCallRanges = Math.max(cost.maxCallRanges, ranges);
			cost.maxCallRows = Math.max(cost.maxCallRows, rows);
			cost.maxCallBytes = Math.max(cost.maxCallBytes, bytes);
			cost.hits += page.page.length;
			cost.done = page.isDone;
			cursor = page.cursor;
		});
	}
	return cost;
}

function report(workload: string, cost: object) {
	const line = JSON.stringify({ workload, ...cost });
	console.log(`BENCH ${line}`);
	if (process.env.CIS_BENCH_OUT)
		appendFileSync(process.env.CIS_BENCH_OUT, `${line}\n`);
}

test.skipIf(!process.env.CIS_BENCH)(
	"scale series W19",
	{ timeout: 7_200_000 },
	async () => {
		for (const n of (process.env.CIS_SCALE ?? "10000,40000,160000")
			.split(",")
			.map(Number)) {
			const t = initConvexTest();
			await seed(t, n);
			report(`W19 N=${n} exact`, await drain(t, "TR-260720-006", 5000));
			report(`W19 N=${n} prefix`, await drain(t, "TR-2607", 1));
			report(`W19 N=${n} cjk`, await drain(t, "停車", 1));
			report(`W19 N=${n} none`, await drain(t, "07-2607", 5000));
		}
	},
);
