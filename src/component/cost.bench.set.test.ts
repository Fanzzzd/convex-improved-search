/// <reference types="vite/client" />
/**
 * Round 2 judge workloads, same harness rules as cost.bench.test.ts.
 *  W10: the W1 corpus written through `set` (not seeded), W1 query drained.
 *       Seeding bypasses set's tag maintenance; this shows the cost is the same.
 *  W11: tag-blind corpus: every memo holds every bigram of TR-260720-006 but
 *       not the number. Query TR-260720-006, fields ["memo"], drained. Tags and
 *       check grams reject nothing; every Entry is verified. Guards that the
 *       worst case stays at one range per candidate, no cliff beyond 0.4.0.
 */
import { appendFileSync } from "node:fs";
import { test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

type T = ReturnType<typeof initConvexTest>;
type Page = { page: { key: string; sortKey: number; matchedFields: string[] }[]; cursor: string | null; isDone: boolean };
type Cost = { calls: number; ranges: number; rows: number; maxCallRanges: number; maxCallRows: number; hits: number; done: boolean };
const NS = "jbench";
let fieldsSupported: boolean | null = null;

async function measure(t: T, args: { query: string; fields?: string[]; limit?: number; budget?: number }, maxCalls: number): Promise<Cost> {
	const cost: Cost = { calls: 0, ranges: 0, rows: 0, maxCallRanges: 0, maxCallRows: 0, hits: 0, done: false };
	let cursor: string | null = null;
	for (let i = 0; i < maxCalls && !cost.done; i++) {
		await t.run(async (ctx) => {
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
					page = await ctx.runQuery(api.lib.search, { namespace: NS, ...rest, cursor });
				}
			} else {
				page = await ctx.runQuery(api.lib.search, { namespace: NS, ...rest, cursor });
			}
			const after = await ctx.meta.getTransactionMetrics();
			const ranges = after.databaseQueries.used - before.databaseQueries.used;
			const rows = after.documentsRead.used - before.documentsRead.used;
			const hits = fields === undefined || fieldsSupported ? page.page : page.page.filter((h) => h.matchedFields.some((n) => fields.includes(n)));
			cost.calls += 1;
			cost.ranges += ranges;
			cost.rows += rows;
			cost.maxCallRanges = Math.max(cost.maxCallRanges, ranges);
			cost.maxCallRows = Math.max(cost.maxCallRows, rows);
			cost.hits += hits.length;
			cost.done = page.isDone;
			cursor = page.cursor;
		});
	}
	return cost;
}

function report(workload: string, cost: Cost) {
	const line = JSON.stringify({ workload, ...cost });
	console.log(`BENCH ${line}`);
	if (process.env.CIS_BENCH_OUT) appendFileSync(process.env.CIS_BENCH_OUT, `${line}\n`);
}

function numbers(memo: (sortKey: number) => string) {
	const entries: { key: string; no: string; memo: string; sortKey: number }[] = [];
	let sortKey = 0;
	for (let day = 0; day < 365; day++) {
		const date = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
		const ymd = `26${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
		for (let n = 1; n <= 10; n++) {
			sortKey += 1;
			const no = `TR-${ymd}-${String(n).padStart(3, "0")}`;
			entries.push({ key: no, no, memo: memo(sortKey), sortKey });
		}
	}
	return entries;
}

test.skipIf(!process.env.CIS_BENCH)("judge workloads W10 W11", { timeout: 3_600_000 }, async () => {
	const viaSet = initConvexTest();
	for (const e of numbers((s) => (s % 97 === 0 ? "補單，原單 TR-260720-006" : "司機墊付停車費"))) {
		await viaSet.mutation(api.lib.set, { namespace: NS, key: e.key, fields: [{ name: "no", value: e.no }, { name: "memo", value: e.memo }], sortKey: e.sortKey });
	}
	report("W10 W1 corpus via set, TR-260720-006 drain", await measure(viaSet, { query: "TR-260720-006", limit: 50 }, 500));
	report("W10b via set, TR-26 memo drained budget 512", await measure(viaSet, { query: "TR-26", fields: ["memo"], budget: 512, limit: 50 }, 500));

	const blind = initConvexTest();
	// Every bigram of "tr-260720-006" without the number itself.
	const tagBlind = "tr-2 r-26 -260 2607 6072 0720 720- 20-0 0-00 -006";
	for (const e of numbers(() => tagBlind)) {
		await blind.mutation(api.lib.set, { namespace: NS, key: e.key, fields: [{ name: "no", value: e.no }, { name: "memo", value: e.memo }], sortKey: e.sortKey });
	}
	report("W11 tag-blind memo, TR-260720-006 fields memo drained", await measure(blind, { query: "TR-260720-006", fields: ["memo"], limit: 50 }, 500));
});
