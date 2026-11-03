import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

// Single-gram routing must still exercise the independent reader's byte
// reservations. No matches prevents early adjacency from hiding this case.
test("single-gram rejected docs cannot overspend a parallel byte budget", async () => {
	const t = initConvexTest();
	for (let start = 0; start < 32; start += 3)
		await t.run(async (ctx) => {
			for (let i = start; i < Math.min(32, start + 3); i++) {
				const key = `point-${String(i).padStart(2, "0")}`;
				await ctx.db.insert("docs", {
					namespace: "point-byte-budget",
					key,
					sortKey: 32 - i,
					fields: { text: "ab" },
					filters: { padding: "x".repeat(600000) },
				});
				await ctx.db.insert("postings", {
					namespace: "point-byte-budget",
					key,
					sortKey: 32 - i,
					gram: "ab",
					g1: "a",
					fields: ["text"],
				});
			}
		});
	let cursor: string | null = null,
		done = false,
		verified = 0;
	for (let call = 0; call < 8 && !done; call++)
		await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const page = await ctx.runQuery(api.lib.search, {
				namespace: "point-byte-budget",
				query: "ab",
				fields: ["text"],
				filters: { keep: "yes" },
				limit: 20,
				budget: 256,
				cursor,
			});
			const after = await ctx.meta.getTransactionMetrics();
			expect(after.bytesRead.used - before.bytesRead.used).toBeLessThanOrEqual(
				16 * 1024 * 1024,
			);
			// Pins this to point reads instead of silently exercising the legacy walk.
			expect(
				after.databaseQueries.used - before.databaseQueries.used,
			).toBeGreaterThanOrEqual(page.verified);
			expect(page.page).toHaveLength(0);
			verified += page.verified;
			if (!page.isDone) {
				expect(page.cursor).not.toBeNull();
				expect(page.cursor).not.toBe(cursor);
			}
			cursor = page.cursor;
			done = page.isDone;
		});
	expect(done).toBe(true);
	expect(verified).toBe(32);
});
