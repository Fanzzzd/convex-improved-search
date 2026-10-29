/// <reference types="vite/client" />
/**
 * Round 5 judge workloads, same harness rules as cost.bench.test.ts:
 *  W20:  12000 docs. The newest 400 hold 停車 and 車費 apart (停車費 in 1 of
 *        40), then 停車費 in 1 of 100 among docs with no query gram. Query
 *        停車費 drained at small limits and budgets: docs mode entered on the
 *        dense stretch must leave even when pages end before a full window.
 *  W20b: the same corpus resumed from a `d: 1` cursor in the dense stretch.
 *  W21:  8000 docs whose share holding every query gram alternates 62% and
 *        38% in blocks of 64 and 160 docs. 停車費 drained.
 *  W22:  6000 docs with 停車 in Field a and 車費 in Field b (停車費 in a in 1
 *        of 50). 停車費 drained, then with `fields: ["b"]`.
 *  W23:  6000 docs that all hold 停車費, a filter that keeps 1 in 100.
 */
import { appendFileSync } from "node:fs";
import { test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { firstCodepoint, fold, gramFieldsOf } from "./grams.js";

const NS = "bench";
type T = ReturnType<typeof initConvexTest>;
type Filters = Record<string, string | number | boolean | null>;
type Entry = {
	key: string;
	fields: Record<string, string>;
	sortKey: number;
	filters?: Filters;
};
type Args = {
	query: string;
	limit: number;
	budget?: number;
	fields?: string[];
	filters?: Filters;
};
type Page = { page: unknown[]; cursor: string | null; isDone: boolean };

function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function seed(t: T, entries: Entry[]) {
	for (let start = 0; start < entries.length; start += 400) {
		await t.run(async (ctx) => {
			for (const entry of entries.slice(start, start + 400)) {
				const fields = Object.fromEntries(
					Object.entries(entry.fields).map(([n, v]) => [n, fold(v)]),
				);
				await ctx.db.insert("docs", {
					namespace: NS,
					key: entry.key,
					fields,
					sortKey: entry.sortKey,
					...(entry.filters ? { filters: entry.filters } : {}),
				});
				for (const [gram, tag] of gramFieldsOf(fields)) {
					await ctx.db.insert("postings", {
						namespace: NS,
						key: entry.key,
						gram,
						g1: firstCodepoint(gram),
						sortKey: entry.sortKey,
						fields: tag,
					});
				}
			}
		});
	}
}

async function drain(
	t: T,
	args: Args,
	maxCalls: number,
	start: string | null = null,
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
	let cursor = start;
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

const FILLER = "司機墊付".repeat(10);

test.skipIf(!process.env.CIS_BENCH)(
	"round 5 judge workloads W20 to W23",
	{ timeout: 3_600_000 },
	async () => {
		const thinning = initConvexTest();
		await seed(
			thinning,
			Array.from({ length: 12000 }, (_, i) => ({
				key: `w${String(i).padStart(5, "0")}`,
				fields: {
					text:
						(i < 400
							? i % 40 === 0
								? "停車費"
								: "停車 車費"
							: i % 100 === 0
								? "停車費"
								: "雜項") + FILLER,
				},
				sortKey: 12000 - i,
			})),
		);
		for (const [limit, budget] of [
			[1, undefined],
			[2, undefined],
			[5, undefined],
			[50, undefined],
			[1, 1],
			[2, 2],
		] as const)
			report(
				`W20 limit ${limit} budget ${budget ?? "default"}`,
				await drain(thinning, { query: "停車費", limit, budget }, 20000),
			);
		const inDocsMode = JSON.stringify({ s: 12000 - 399, k: "w00399", d: 1 });
		for (const [limit, budget] of [
			[1, 1],
			[1, 2],
			[2, 4],
			[1, 256],
		] as const)
			report(
				`W20b limit ${limit} budget ${budget}`,
				await drain(
					thinning,
					{ query: "停車費", limit, budget },
					20000,
					inDocsMode,
				),
			);

		for (const block of [64, 160]) {
			const rand = prng(21 + block);
			const oscillating = initConvexTest();
			await seed(
				oscillating,
				Array.from({ length: 8000 }, (_, i) => {
					const share = Math.floor(i / block) % 2 === 0 ? 0.62 : 0.38;
					const text =
						rand() < share ? (rand() < 0.08 ? "停車費" : "停車 車費") : "雜項";
					return {
						key: `o${String(i).padStart(5, "0")}`,
						fields: { text: text + FILLER },
						sortKey: 8000 - i,
					};
				}),
			);
			report(
				`W21 block ${block}`,
				await drain(oscillating, { query: "停車費", limit: 50 }, 5000),
			);
		}

		const split = initConvexTest();
		await seed(
			split,
			Array.from({ length: 6000 }, (_, i) => ({
				key: `s${String(i).padStart(5, "0")}`,
				fields:
					i % 50 === 0 ? { a: "停車費", b: "x" } : { a: "停車 x", b: "車費 y" },
				sortKey: 6000 - i,
			})),
		);
		report(
			"W22 split fields",
			await drain(split, { query: "停車費", limit: 50 }, 5000),
		);
		report(
			"W22 split fields, fields b",
			await drain(split, { query: "停車費", limit: 50, fields: ["b"] }, 5000),
		);

		const filtered = initConvexTest();
		await seed(
			filtered,
			Array.from({ length: 6000 }, (_, i) => ({
				key: `f${String(i).padStart(5, "0")}`,
				fields: { text: "停車費" + FILLER },
				sortKey: 6000 - i,
				filters: { rare: i % 100 === 0 },
			})),
		);
		report(
			"W23 dense, rare filter",
			await drain(
				filtered,
				{ query: "停車費", limit: 50, filters: { rare: true } },
				5000,
			),
		);
	},
);
