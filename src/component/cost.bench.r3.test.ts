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

/**
 * Round 4 judge workloads:
 *  W15: 6300 docs of ~140 codepoints; the newest 300 hold 停車 (half
 *       停車場), the rest 1 in 50. 停車場 and 停車 drained: docs mode must
 *       hand back to postings when candidates thin out.
 *  W16: 6000 docs; 停車 in every one; 停車費 in the newest 600, then 1 in
 *       100. 停車費 drained: the candidate gram stays dense while a check
 *       turns selective.
 *  W12b: W12 with unique sortKeys (no tie group).
 *  W17: two independent grams in half the docs each; abc in 1 in 10 of
 *       docs holding both. Guards swap oscillation.
 *  W18: ab in 1 of 10, bc in every doc, abc in 1 of 100. Guards a check
 *       that keeps falling behind.
 */
test.skipIf(!process.env.CIS_BENCH)(
	"round 4 judge workloads W15 W16 W12b W17 W18",
	{ timeout: 3_600_000 },
	async () => {
		const denseThenSparse = initConvexTest();
		const filler15 = "過磅單司機墊付".repeat(20);
		await seed(
			denseThenSparse,
			Array.from({ length: 6300 }, (_, i) => {
				const holds = i < 300 || i % 50 === 0;
				const text = holds ? (i % 2 === 0 ? "停車場月租" : "停車費") : "雜項";
				return {
					key: `w${String(i).padStart(5, "0")}`,
					fields: { text: text + filler15 },
					sortKey: 6300 - i,
				};
			}),
		);
		for (const query of ["停車場", "停車"]) {
			report(
				`W15 dense then sparse, ${query} drained`,
				await drain(denseThenSparse, { query, limit: 50 }, 2000),
			);
		}

		const checkTurns = initConvexTest();
		const filler16 = "司機墊付".repeat(40);
		await seed(
			checkTurns,
			Array.from({ length: 6000 }, (_, i) => ({
				key: `v${String(i).padStart(5, "0")}`,
				fields: {
					text: (i < 600 || i % 100 === 0 ? "停車費" : "停車位") + filler16,
				},
				sortKey: 6000 - i,
			})),
		);
		report(
			"W16 check turns selective, 停車費 drained",
			await drain(checkTurns, { query: "停車費", limit: 50 }, 2000),
		);

		const big = initConvexTest();
		const filler = "😀".repeat(4088);
		await seed(
			big,
			Array.from({ length: 1200 }, (_, i) => ({
				key: `m${String(i).padStart(4, "0")}`,
				fields: { text: filler + (i % 25 === 0 ? "qz" : "qq") + "ab bc" },
				sortKey: i,
			})),
		);
		report(
			"W12b max-size docs, unique sortKeys, qz drained",
			await drain(big, { query: "qz", limit: 200, budget: 768 }, 500),
		);

		let a = 777;
		const rand = () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const halfDense = initConvexTest();
		await seed(
			halfDense,
			Array.from({ length: 4000 }, (_, i) => {
				const ab = rand() < 0.5;
				const bc = rand() < 0.5;
				return {
					key: `o${String(i).padStart(5, "0")}`,
					fields: {
						text:
							(ab ? "xab " : "x ") +
							(bc ? "ybc " : "y ") +
							(ab && bc && rand() < 0.1 ? "abc" : ""),
					},
					sortKey: 4000 - i,
				};
			}),
		);
		report(
			"W17 two half-dense grams, abc drained",
			await drain(halfDense, { query: "abc", limit: 50 }, 2000),
		);

		const behind = initConvexTest();
		await seed(
			behind,
			Array.from({ length: 6000 }, (_, i) => ({
				key: `b${String(i).padStart(5, "0")}`,
				fields: {
					text: (i % 10 === 0 ? (i % 100 === 0 ? "abc" : "ab") : "x") + " bc",
				},
				sortKey: 6000 - i,
			})),
		);
		report(
			"W18 check keeps falling behind, abc drained",
			await drain(behind, { query: "abc", limit: 50 }, 2000),
		);
	},
);
