import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { gramFieldsOf, firstCodepoint } from "../shared/grams.js";

test("early density probing does not discard useful field-tag pruning", async () => {
	const t = initConvexTest();
	const entries = Array.from({ length: 400 }, (_, i) => ({
		key: `scope-${String(i).padStart(3, "0")}`,
		sortKey: 400 - i,
		fields: { a: "ab", b: i < 2 || i % 11 === 0 ? "ab" : "zz" },
		filters: { padding: "x".repeat(2048) },
	}));
	await t.run(async (ctx) => {
		for (const entry of entries) {
			await ctx.db.insert("docs", { namespace: "tag-pruning-cost", ...entry });
			for (const [gram, fields] of gramFieldsOf(entry.fields))
				await ctx.db.insert("postings", {
					namespace: "tag-pruning-cost",
					key: entry.key,
					sortKey: entry.sortKey,
					gram,
					g1: firstCodepoint(gram),
					fields,
				});
		}
	});
	let cursor: string | null = null,
		done = false,
		calls = 0,
		bytes = 0;
	const actual: string[] = [];
	for (let call = 0; call < 10 && !done; call++)
		await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const r = await ctx.runQuery(api.lib.search, {
				namespace: "tag-pruning-cost",
				query: "ab",
				fields: ["b"],
				limit: 50,
				cursor,
			});
			const after = await ctx.meta.getTransactionMetrics();
			calls++;
			bytes += after.bytesRead.used - before.bytesRead.used;
			actual.push(...r.page.map((hit) => hit.key));
			cursor = r.cursor;
			done = r.isDone;
		});
	if (process.env.CIS_TAG_COST_OUT)
		appendFileSync(
			process.env.CIS_TAG_COST_OUT,
			JSON.stringify({
				label: process.env.CIS_TAG_COST_LABEL ?? "unknown",
				calls,
				bytes,
				hits: actual.length,
				done,
			}) + "\n",
		);
	expect(actual).toEqual(
		entries.filter((e) => e.fields.b === "ab").map((e) => e.key),
	);
	expect(done).toBe(true);
	expect(calls).toBe(1);
	expect(bytes).toBeLessThan(250000);
});
