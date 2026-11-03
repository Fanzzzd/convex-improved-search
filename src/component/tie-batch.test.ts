import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { gramFieldsOf, firstCodepoint } from "../shared/grams.js";

async function run(sparse: boolean, stale: boolean) {
	const t = initConvexTest();
	const count = sparse ? 80 : 40;
	const entries = Array.from({ length: count }, (_, i) => ({
		key: `n${String(i).padStart(2, "0")}`,
		sortKey: -0,
		fields: { text: !sparse || i % 2 === 0 ? "停車費" : "別項" },
	}));
	await t.run(async (ctx) => {
		for (const entry of entries) {
			await ctx.db.insert("docs", { namespace: "tie-batch", ...entry });
			for (const [gram, fields] of gramFieldsOf(entry.fields))
				await ctx.db.insert("postings", {
					namespace: "tie-batch",
					key: entry.key,
					sortKey: -0,
					gram,
					g1: firstCodepoint(gram),
					fields,
				});
		}
		if (stale)
			for (const key of ["z99", "z98"])
				await ctx.db.insert("postings", {
					namespace: "tie-batch",
					key,
					sortKey: -0,
					gram: "停車",
					g1: "停",
					fields: ["text"],
				});
	});
	let cursor: string | null = null,
		done = false,
		calls = 0,
		ranges = 0,
		rows = 0,
		bytes = 0;
	const keys: string[] = [];
	for (let call = 0; call < 100 && !done; call++)
		await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const r = await ctx.runQuery(api.lib.search, {
				namespace: "tie-batch",
				query: "停車",
				limit: 7,
				cursor,
			});
			const after = await ctx.meta.getTransactionMetrics();
			calls++;
			ranges += after.databaseQueries.used - before.databaseQueries.used;
			rows += after.documentsRead.used - before.documentsRead.used;
			bytes += after.bytesRead.used - before.bytesRead.used;
			keys.push(...r.page.map((hit) => hit.key));
			if (!r.isDone) {
				expect(r.cursor).not.toBeNull();
				expect(r.cursor).not.toBe(cursor);
			}
			cursor = r.cursor;
			done = r.isDone;
		});
	expect(done).toBe(true);
	expect(keys).toEqual(
		entries
			.toReversed()
			.filter((e) => e.fields.text.includes("停車"))
			.map((e) => e.key),
	);
	if (!sparse && !stale) {
		expect(calls).toBe(6);
		expect(ranges).toBeLessThanOrEqual(16);
	}
	if (process.env.CIS_TIE_OUT)
		appendFileSync(
			process.env.CIS_TIE_OUT,
			JSON.stringify({
				sparse,
				stale,
				calls,
				ranges,
				rows,
				bytes,
				hits: keys.length,
				done,
			}) + "\n",
		);
}

test("one bounded range verifies a dense -0 tie batch", async () =>
	run(false, false));
test("a sparse tie batch falls back after at most one unexpected row", async () =>
	run(true, false));
test("a stale prefix never skips later live entries at the same sort key", async () =>
	run(true, true));
