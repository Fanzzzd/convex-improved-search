import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

test("both budget fallbacks decide exactly one candidate under a tightened limit", async () => {
	const t = initConvexTest();
	for (const key of ["z-2", "z-1", "z-0", "a"])
		await t.run(async (ctx) => {
			await ctx.db.insert("docs", {
				namespace: "fallback-checked",
				key,
				sortKey: 0,
				fields: { text: "abc" },
				filters: { padding: "x".repeat(900000) },
			});
			for (const [gram, g1] of [
				["ab", "a"],
				["bc", "b"],
			])
				await ctx.db.insert("postings", {
					namespace: "fallback-checked",
					key,
					sortKey: 0,
					gram,
					g1,
					fields: ["text"],
				});
		});
	for (const [plan, expectedReads] of [
		[{ g: ["ab", "bc"] }, 2],
		[{ d: 1 }, 1],
	] as const)
		await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const cursor = JSON.stringify({ s: 0, k: "z", ...plan });
			const result = await ctx.runQuery(
				api.lib.search,
				{
					namespace: "fallback-checked",
					query: "abc",
					limit: 1,
					budget: 1,
					cursor,
				},
				{ transactionLimits: { bytesRead: 4.5 * 1024 * 1024 } },
			);
			const after = await ctx.meta.getTransactionMetrics();
			expect(result.page.map((hit) => hit.key)).toEqual(["a"]);
			expect(result.verified).toBe(1);
			expect(result.scanned).toBe(1);
			expect(result.isDone).toBe(false);
			expect(result.cursor).not.toBe(cursor);
			// Below the optional-row guard but above fallback+caller reserve. These
			// counts pin fallback execution rather than a normal three-row tie walk.
			expect(after.documentsRead.used - before.documentsRead.used).toBe(
				expectedReads,
			);
			expect(after.bytesRead.used - before.bytesRead.used).toBeLessThanOrEqual(
				2.5 * 1024 * 1024,
			);
		});
});
