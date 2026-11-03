import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

test(
	"numeric filter encoding cannot undercharge the independent byte budget",
	{ timeout: 30000 },
	async () => {
		const t = initConvexTest();
		const filters = Object.fromEntries(
			Array.from({ length: 1000 }, (_, i) => [
				`n${String(i).padStart(4, "0")}${"x".repeat(12)}`,
				0,
			]),
		);
		for (let start = 0; start < 700; start += 20)
			await t.run(async (ctx) => {
				for (let i = start; i < Math.min(700, start + 20); i++) {
					const key = `numeric-${String(i).padStart(3, "0")}`;
					await ctx.db.insert("docs", {
						namespace: "numeric-byte-budget",
						key,
						sortKey: 700 - i,
						fields: { text: "ab" },
						filters,
					});
					await ctx.db.insert("postings", {
						namespace: "numeric-byte-budget",
						key,
						sortKey: 700 - i,
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
				const result = await ctx.runQuery(api.lib.search, {
					namespace: "numeric-byte-budget",
					query: "ab",
					fields: ["text"],
					filters: { keep: "yes" },
					limit: 20,
					budget: 768,
					cursor,
				});
				const after = await ctx.meta.getTransactionMetrics();
				const bytes = after.bytesRead.used - before.bytesRead.used;
				if (process.env.CIS_NUMERIC_OUT)
					appendFileSync(
						process.env.CIS_NUMERIC_OUT,
						JSON.stringify({
							label: process.env.CIS_NUMERIC_LABEL ?? "unknown",
							call,
							bytes,
							verified: result.verified,
							done: result.isDone,
						}) + "\n",
					);
				expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
				expect(result.page).toHaveLength(0);
				verified += result.verified;
				if (!result.isDone) {
					expect(result.cursor).not.toBeNull();
					expect(result.cursor).not.toBe(cursor);
				}
				cursor = result.cursor;
				done = result.isDone;
			});
		expect(done).toBe(true);
		expect(verified).toBe(700);
	},
);
