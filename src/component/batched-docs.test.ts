import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

/**
 * Far candidates read their docs by key in batches. Drains end inside a
 * batch (the candidate range runs out) and stop on the budget mid-batch;
 * every page sequence must still equal the oracle.
 */
const NS = "batched";

/** Enough hits that idle checks drop well before the oldest, so later calls batch from their first candidate and run into the range's end. */
const DOCS = 1000;

test("batched far-candidate docs drain to the oracle at every page size and budget", async () => {
	const t = initConvexTest();
	const fields = (i: number) => [
		{
			name: "route",
			value: i % 9 === 0 ? `HK route ${i} ROUTE-ONLY` : `TP route ${i}`,
		},
		{ name: "no", value: `TR-${i}` },
	];
	for (let i = 0; i < DOCS; i++)
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: `k${String(i).padStart(4, "0")}`,
			sortKey: i,
			fields: fields(i),
			// Every third hit fails the filter, so batches hold rejections.
			filters: { ok: i % 27 !== 0 },
		});
	const oracle = Array.from({ length: DOCS }, (_, i) => DOCS - 1 - i)
		.filter((i) => i % 9 === 0 && i % 27 !== 0)
		.map((i) => `k${String(i).padStart(4, "0")}`);
	for (const limit of [1, 3, 20])
		for (const budget of [2, 5, 512]) {
			const keys: string[] = [];
			let cursor: string | null = null;
			for (let call = 0; call < 2000; call++) {
				const result: {
					page: { key: string }[];
					cursor: string | null;
					isDone: boolean;
				} = await t.query(api.lib.search, {
					namespace: NS,
					query: "ROUTE-ONLY",
					fields: ["route"],
					filters: { ok: true },
					cursor,
					limit,
					budget,
				});
				keys.push(...result.page.map((hit) => hit.key));
				cursor = result.cursor;
				if (result.isDone) break;
			}
			expect(keys, `limit ${limit} budget ${budget}`).toEqual(oracle);
		}
}, 300_000);
