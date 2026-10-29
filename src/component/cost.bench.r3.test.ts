/// <reference types="vite/client" />
/**
 * Round 3 judge workloads, same harness rules as cost.bench.test.ts, plus
 * bytesRead per workload:
 *  W12: 1200 docs of ~4090 codepoints (emoji filler), "qz" in 1 of 25,
 *       query "qz", limit 200, budget 768, drained. Sparse hits among
 *       max-size docs: the docs walk must not read far more bytes than 0.4.0.
 *  W13: 6000 docs; candidate gram "ab" in every 20th; check gram "bc" in
 *       every one of the newest 600, then only beside 1 in 50 "ab". Query
 *       "abc" drained: the cost of dropping a check that is dense early.
 *  W14: "ab" in every 40th of the newest 1280 docs, then in every doc; "bc"
 *       in every one of the newest 1280, then in 1 of 100. Query "abc"
 *       drained: a probe that misjudges the candidate gram.
 */
import { appendFileSync } from "node:fs";
import { test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import * as gramsModule from "./grams.js";

const grams = gramsModule as typeof gramsModule & {
	gramFieldsOf?: typeof gramsModule.gramFieldsOf;
};
const NS = "bench";
type T = ReturnType<typeof initConvexTest>;
type Entry = { key: string; fields: Record<string, string>; sortKey: number };
type Page = { page: unknown[]; cursor: string | null; isDone: boolean };

async function seed(t: T, entries: Entry[]) {
	await t.run(async (ctx) => {
		for (const entry of entries) {
			const fields = Object.fromEntries(
				Object.entries(entry.fields).map(([n, v]) => [n, grams.fold(v)]),
			);
			await ctx.db.insert("docs", {
				namespace: NS,
				key: entry.key,
				fields,
				sortKey: entry.sortKey,
			});
			// Builds before 0.5.0 have no posting tags (no gramFieldsOf).
			const tagged: Map<string, string[] | undefined> =
				grams.gramFieldsOf?.(fields) ??
				new Map(
					[...grams.documentGramsOfFields(fields)].map((gram) => [
						gram,
						undefined,
					]),
				);
			for (const [gram, tag] of tagged) {
				await ctx.db.insert("postings", {
					namespace: NS,
					key: entry.key,
					gram,
					g1: grams.firstCodepoint(gram),
					sortKey: entry.sortKey,
					...(tag === undefined ? {} : { fields: tag }),
				} as never);
			}
		}
	});
}

async function drain(
	t: T,
	args: { query: string; limit: number; budget?: number },
	maxCalls: number,
) {
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
				...args,
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
	"round 3 judge workloads W12 W13 W14",
	{ timeout: 3_600_000 },
	async () => {
		const big = initConvexTest();
		const filler = "😀".repeat(4088);
		await seed(
			big,
			Array.from({ length: 1200 }, (_, i) => ({
				key: `m${String(i).padStart(4, "0")}`,
				fields: { text: filler + (i % 25 === 0 ? "qz" : "qq") + "ab bc" },
				sortKey: i % 2 === 0 ? i : 7,
			})),
		);
		report(
			"W12 max-size docs, qz 1 in 25, drained",
			await drain(big, { query: "qz", limit: 200, budget: 768 }, 500),
		);

		const n = 6000;
		const denseEarly = initConvexTest();
		await seed(
			denseEarly,
			Array.from({ length: n }, (_, i) => {
				const hasAB = i % 20 === 0;
				const hasBC = i < 600 || (hasAB && i % 1000 === 0);
				return {
					key: `c${String(i).padStart(5, "0")}`,
					fields: {
						text:
							(hasAB ? "xab" : "x") +
							(hasBC ? " bc" : "") +
							(hasAB && hasBC ? " abc" : ""),
					},
					sortKey: n - i,
				};
			}),
		);
		report(
			"W13 check dense early, abc drained",
			await drain(denseEarly, { query: "abc", limit: 50 }, 2000),
		);

		const misjudged = initConvexTest();
		await seed(
			misjudged,
			Array.from({ length: n }, (_, i) => {
				const hasAB = i < 1280 ? i % 40 === 0 : true;
				const hasBC = i < 1280 ? true : i % 100 === 0;
				return {
					key: `d${String(i).padStart(5, "0")}`,
					fields: {
						text:
							(hasAB ? "xab" : "x") +
							(hasBC ? " bc" : "") +
							(hasAB && hasBC && i % 2 === 0 ? " abc" : ""),
					},
					sortKey: n - i,
				};
			}),
		);
		report(
			"W14 probe misjudged, abc drained",
			await drain(misjudged, { query: "abc", limit: 50 }, 2000),
		);
	},
);
