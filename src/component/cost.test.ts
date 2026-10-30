/// <reference types="vite/client" />
/**
 * Read cost of `search` on the shape that broke payable-system in prod
 * (0.4.0): thousands of document numbers sharing a prefix (`TR-26MMDD-NNN`),
 * searched for one number, by a caller that calls `search` several times in
 * one query. Every query gram's prefix part is in every Entry, so cost
 * depends on finding the sparse grams and on not paying an index range per
 * rejected candidate.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { firstCodepoint, fold, gramFieldsOf } from "./grams.js";

const NS = "reimbursements";
const RANGE_LIMIT = 4096;

type T = ReturnType<typeof initConvexTest>;
type SearchArgs = {
	query: string;
	fields?: string[];
	filters?: Record<string, string | number | boolean | null>;
	limit?: number;
	budget?: number;
};
type Page = {
	page: { key: string; sortKey: number; matchedFields: string[] }[];
	cursor: string | null;
	isDone: boolean;
	scanned: number;
};

/** One number per day of 2026, ten per day; the memo of every 97th cites TR-260720-006. */
function corpus(): {
	key: string;
	fields: Record<string, string>;
	sortKey: number;
}[] {
	const entries = [];
	let sortKey = 0;
	for (let day = 0; day < 365; day++) {
		const date = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
		const ymd = `26${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
		for (let n = 1; n <= 10; n++) {
			sortKey += 1;
			const no = `TR-${ymd}-${String(n).padStart(3, "0")}`;
			entries.push({
				key: no,
				fields: {
					no,
					memo:
						sortKey % 97 === 0 ? "補單，原單 TR-260720-006" : "司機墊付停車費",
				},
				sortKey,
			});
		}
	}
	return entries;
}

/** Writes the rows `set` would write, in one transaction (thousands of `set` calls are slow under convex-test). */
async function seed(t: T) {
	const entries = corpus();
	await t.run(async (ctx) => {
		for (const entry of entries) {
			const fields = Object.fromEntries(
				Object.entries(entry.fields).map(([name, value]) => [
					name,
					fold(value),
				]),
			);
			await ctx.db.insert("docs", {
				namespace: NS,
				key: entry.key,
				fields,
				sortKey: entry.sortKey,
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
	return entries;
}

type Call = { page: Page; ranges: number; rows: number };

/**
 * Runs `calls` consecutive searches in ONE transaction, the way an app
 * query that loops over `search` does, and measures each call.
 */
async function inOneTransaction(
	t: T,
	args: SearchArgs,
	calls: number,
	before?: number,
	start: string | null = null,
): Promise<{ calls: Call[]; totalRanges: number }> {
	return await t.run(async (ctx) => {
		// The caller's own reads before searching.
		for (let i = 0; i < (before ?? 0); i++) {
			await ctx.db.query("docs").first();
		}
		const out: Call[] = [];
		let cursor = start;
		for (let i = 0; i < calls; i++) {
			const start = await ctx.meta.getTransactionMetrics();
			const page: Page = await ctx.runQuery(api.lib.search, {
				namespace: NS,
				...args,
				cursor,
			});
			const end = await ctx.meta.getTransactionMetrics();
			out.push({
				page,
				ranges: end.databaseQueries.used - start.databaseQueries.used,
				rows: end.documentsRead.used - start.documentsRead.used,
			});
			cursor = page.cursor;
			if (page.isDone) break;
		}
		const metrics = await ctx.meta.getTransactionMetrics();
		return { calls: out, totalRanges: metrics.databaseQueries.used };
	});
}

/** Drain across transactions; returns every hit key. */
async function drain(
	t: T,
	args: SearchArgs,
	start: string | null = null,
): Promise<string[]> {
	const keys: string[] = [];
	let cursor = start;
	for (let round = 0; round < 500; round++) {
		const result: Page = await t.query(api.lib.search, {
			namespace: NS,
			...args,
			cursor,
		});
		keys.push(...result.page.map((hit) => hit.key));
		if (result.isDone) return keys;
		cursor = result.cursor;
	}
	throw new Error("search did not terminate");
}

describe("common prefix, rare suffix (payable-system TR-260720-006)", () => {
	// Read-only tests share one seeded index.
	let t: T;
	beforeAll(async () => {
		t = initConvexTest();
		await seed(t);
	}, 120_000);

	test("one call finds the number and finishes, in under 256 index ranges", async () => {
		const { calls } = await inOneTransaction(
			t,
			{ query: "TR-260720-006", budget: 512 },
			1,
		);
		const [call] = calls;
		expect(call.page.isDone).toBe(true);
		const expected = corpus()
			.filter((entry) =>
				Object.values(entry.fields).some((text) =>
					text.includes("TR-260720-006"),
				),
			)
			.reverse()
			.map((entry) => entry.key);
		expect(expected).toContain("TR-260720-006");
		expect(call.page.page.map((hit) => hit.key)).toEqual(expected);
		// 0.4.0: 2057 ranges and 5 of 38 hits, not done (it streamed a Gram every Entry holds).
		expect(call.ranges).toBeLessThan(256);
		expect(call.rows).toBeLessThan(3_000);
	}, 120_000);

	test("fields restricts verification, so fill-style paging needs no matchedFields post-filter", async () => {
		const { calls } = await inOneTransaction(
			t,
			{ query: "TR-260720-006", fields: ["no"], budget: 512 },
			1,
		);
		expect(
			calls[0].page.page.map((hit) => [hit.key, hit.matchedFields]),
		).toEqual([["TR-260720-006", ["no"]]]);
		expect(calls[0].page.isDone).toBe(true);
	}, 120_000);

	test("five budget-512 calls in one transaction stay under the 4096-range limit", async () => {
		// The incident loop: a prefix every Entry holds, filtered to a field
		// that rarely matches, so each call verifies candidates and finds few.
		const args = { query: "TR-26", fields: ["memo"], budget: 512, limit: 50 };
		const { calls, totalRanges } = await inOneTransaction(t, args, 5);
		expect(totalRanges).toBeLessThanOrEqual(RANGE_LIMIT);
		expect(
			calls.flatMap((call) => call.page.page.map((hit) => hit.matchedFields)),
		).toEqual(calls.flatMap((call) => call.page.page.map(() => ["memo"])));
		// Paging the rest across transactions loses nothing.
		const memoHits = corpus().filter((entry) =>
			entry.fields.memo.includes("TR-26"),
		);
		expect(await drain(t, args)).toEqual(
			memoHits.reverse().map((entry) => entry.key),
		);
	}, 120_000);

	test("a call that starts with little transaction headroom caps itself instead of overrunning", async () => {
		const args = { query: "TR-26", fields: ["memo"], budget: 768, limit: 200 };
		// 3590 used leaves 6 ranges past the 512 reserve: too few to drain.
		const { calls, totalRanges } = await inOneTransaction(t, args, 1, 3_590);
		expect(totalRanges).toBeLessThanOrEqual(RANGE_LIMIT);
		expect(calls[0].page.isDone).toBe(false);
		expect(calls[0].page.cursor).not.toBeNull();
	}, 120_000);

	test("a call that starts inside the reserve reads nothing and hands its cursor back", async () => {
		const t = initConvexTest();
		const args = { query: "abcdefghijklmnopq", limit: 50 };
		for (let i = 0; i < 3; i += 1) {
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: String(i),
				fields: [{ name: "text", value: args.query }],
				sortKey: i,
			});
		}
		// 16 ranges left: the probe alone (up to 16 grams) would overrun.
		const first: Page = await t.query(api.lib.search, {
			namespace: NS,
			...args,
			limit: 1,
		});
		expect(first.cursor).not.toBeNull();
		for (const cursor of [null, first.cursor]) {
			const { calls, totalRanges } = await inOneTransaction(
				t,
				args,
				1,
				RANGE_LIMIT - 16,
				cursor,
			);
			expect(totalRanges).toBe(RANGE_LIMIT - 16);
			const page = calls[0].page;
			expect(page.page).toEqual([]);
			expect(page.isDone).toBe(false);
			expect(page.cursor).not.toBeNull();
			if (cursor !== null) expect(page.cursor).toBe(cursor);
			// The next transaction resumes where the cursor points.
			expect(await drain(t, args, page.cursor)).toEqual(
				await drain(t, args, cursor),
			);
		}
	}, 120_000);
});
