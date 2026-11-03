import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const CAP = 16 * 1024 * 1024;

test("checked first seek respects caller byte headroom across a large tie group", async () => {
	const t = initConvexTest();
	for (let i = 0; i < 20; i++)
		await t.run(async (ctx) => {
			const caller = i < 16;
			const key = caller ? `caller-${i}` : i === 19 ? "a" : `z-${i}`;
			await ctx.db.insert("docs", {
				namespace: caller ? "checked-caller" : "checked-ties",
				key,
				sortKey: 0,
				fields: { text: i === 19 ? "abc" : "nothing" },
				filters: { padding: "x".repeat(900000) },
			});
			if (i === 19)
				for (const [gram, g1] of [
					["ab", "a"],
					["bc", "b"],
				])
					await ctx.db.insert("postings", {
						namespace: "checked-ties",
						key,
						sortKey: 0,
						gram,
						g1,
						fields: ["text"],
					});
		});
	await t.run(async (ctx) => {
		const before = await ctx.meta.getTransactionMetrics();
		await ctx.db
			.query("docs")
			.withIndex("by_ns_key", (q) => q.eq("namespace", "checked-caller"))
			.take(16);
		await ctx.runQuery(api.lib.search, {
			namespace: "checked-ties",
			query: "abc",
			limit: 1,
		});
		const after = await ctx.meta.getTransactionMetrics();
		expect(after.bytesRead.used - before.bytesRead.used).toBeLessThanOrEqual(
			CAP,
		);
	});
});

test("wide posting tags cannot make the checked gram probes exceed the byte cap", async () => {
	const t = initConvexTest();
	// 3072 searchable codepoints, 768 fields, and each doc below 1 MiB.
	const names = Array.from(
		{ length: 768 },
		(_, i) => `f${String(i).padStart(3, "0")}${"x".repeat(500)}`,
	);
	const fields = Object.fromEntries(names.map((name) => [name, "aaab"]));
	for (let i = 0; i < 32; i++)
		await t.run(async (ctx) => {
			const key = `wide-${String(i).padStart(2, "0")}`;
			await ctx.db.insert("docs", {
				namespace: "checked-wide-tags",
				key,
				sortKey: 32 - i,
				fields,
			});
			for (const [gram, g1] of [
				["aa", "a"],
				["ab", "a"],
			])
				await ctx.db.insert("postings", {
					namespace: "checked-wide-tags",
					key,
					sortKey: 32 - i,
					gram,
					g1,
					fields: names,
				});
		});
	await t.run(async (ctx) => {
		const before = await ctx.meta.getTransactionMetrics();
		await ctx.runQuery(api.lib.search, {
			namespace: "checked-wide-tags",
			query: "aaab",
			limit: 1,
		});
		const after = await ctx.meta.getTransactionMetrics();
		expect(after.bytesRead.used - before.bytesRead.used).toBeLessThanOrEqual(
			CAP,
		);
	});
});
