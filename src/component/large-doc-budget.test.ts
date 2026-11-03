import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

type T = ReturnType<typeof initConvexTest>;
const CAP = 16 * 1024 * 1024;
const NS = "large-byte-proof";
const keyAt = (i: number) => `large-${i.toString().padStart(2, "0")}`;

async function seed(t: T, callerRows = 0) {
	// Keep each write transaction below 4 MiB. Searchable text is tiny;
	// legal filters make each doc large, which MAX_TEXT_LENGTH does not cap.
	for (let start = 0; start < 32 + callerRows; start += 3) {
		await t.run(async (ctx) => {
			for (let i = start; i < Math.min(32 + callerRows, start + 3); i++) {
				const key = keyAt(i),
					namespace = i < 32 ? NS : "caller-byte-proof";
				await ctx.db.insert("docs", {
					namespace,
					key,
					sortKey: 32 - i,
					fields: { text: "abc" },
					filters: { padding: "x".repeat(600_000) },
				});
				// A live Check Gram keeps the adjacency shortcut out of this
				// regression, so the byte reservation itself must protect it.
				if (i < 32)
					for (const [gram, g1] of [
						["ab", "a"],
						["bc", "b"],
					])
						await ctx.db.insert("postings", {
							namespace,
							key,
							sortKey: 32 - i,
							gram,
							g1,
							fields: ["text"],
						});
			}
		});
	}
}

async function drain(t: T, callerRows = 0) {
	let cursor: string | null = null,
		done = false;
	const hits: string[] = [],
		calls: object[] = [];
	for (let call = 0; call < 40 && !done; call++) {
		await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			if (callerRows > 0 && call === 0)
				await ctx.db
					.query("docs")
					.withIndex("by_ns_key", (q) => q.eq("namespace", "caller-byte-proof"))
					.take(callerRows);
			const page = await ctx.runQuery(api.lib.search, {
				namespace: NS,
				query: "abc",
				limit: 50,
				budget: 256,
				cursor,
			});
			const after = await ctx.meta.getTransactionMetrics();
			const bytesRead = after.bytesRead.used - before.bytesRead.used;
			calls.push({
				bytesRead,
				hits: page.page.length,
				verified: page.verified,
				done: page.isDone,
			});
			expect(
				bytesRead,
				`call ${call}, caller rows ${callerRows}`,
			).toBeLessThanOrEqual(CAP);
			hits.push(...page.page.map((hit) => hit.key));
			if (!page.isDone) {
				expect(page.cursor).not.toBeNull();
				expect(page.cursor).not.toBe(cursor);
			}
			cursor = page.cursor;
			done = page.isDone;
		});
	}
	expect(done).toBe(true);
	expect(hits).toEqual(Array.from({ length: 32 }, (_, i) => keyAt(i)));
	if (process.env.CIS_BYTE_OUT)
		appendFileSync(
			process.env.CIS_BYTE_OUT,
			JSON.stringify({ callerRows, calls }) + "\n",
		);
}

test("verification rounds stay within the byte limit and finish every large doc", async () => {
	const t = initConvexTest();
	await seed(t);
	await drain(t);
});

test("pending reads preserve byte headroom already spent by the caller", async () => {
	const t = initConvexTest();
	await seed(t, 21);
	await drain(t, 21);
});
