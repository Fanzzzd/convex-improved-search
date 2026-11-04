import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { firstCodepoint, fold, gramFieldsOf } from "../shared/grams.js";

/**
 * Issue #13's corpus: 3650 dispatch Entries with eight short Fields, the
 * target number in `cargo` of every 97th, filters on every Entry. Pages of
 * 20 with budget 512, one call per page, as the reporting app calls it.
 */
const NS = "fixture";
const TARGET = "TR-260720-006";

function docFields(index: number): Record<string, string> {
	const day = Math.floor(index / 10);
	const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
	const number = `TR-26${date.slice(5, 7)}${date.slice(8, 10)}-${String((index % 10) + 1).padStart(3, "0")}`;
	return {
		cargo: `${number}${(index + 1) % 97 === 0 ? ` reference ${TARGET}` : ""}`,
		date,
		route:
			index % 17 === 0
				? `香港 route ${index} ROUTE-ONLY`
				: `Taipei route ${index}`,
		vehicle: `PLATE-${index}`,
		personnel: `Driver ${index}`,
		totals: `HKD ${index * 10}`,
		evidence: `receipt-${index}`,
		submittedAt: `${date} ${String(index % 24).padStart(2, "0")}:00`,
	};
}

const SCENARIOS = [
	["original-query", TARGET, ["cargo"]],
	["zero-match", "TR-260720-999999", ["cargo"]],
	["broad-prefix", "TR-26", ["cargo"]],
	["route-selected", "ROUTE-ONLY", ["route"]],
	["route-unselected", "ROUTE-ONLY", ["cargo"]],
	["cjk", "香港", ["route"]],
	["single-codepoint", "香", ["route"]],
	// No `fields`, and pages filled by up to 5 calls, as an app searching
	// every Field calls it.
	["original-unscoped", TARGET, null],
	["zero-match-unscoped", "TR-260720-999999", null],
	["route-unscoped", "ROUTE-ONLY", null],
] as const;

test.skipIf(!process.env.CIS_SPARSE_OUT)(
	"issue #13 sparse identifier screen",
	{ timeout: 600000 },
	async () => {
		const entries = Array.from({ length: 3650 }, (_, index) => {
			const raw = docFields(index);
			return {
				key: `dispatch-${String(index).padStart(6, "0")}`,
				sortKey: index + 1,
				fields: Object.fromEntries(
					Object.entries(raw).map(([name, value]) => [name, fold(value)]),
				),
			};
		});
		const t = initConvexTest();
		const filters = { section: "pending", status: "submitted" };
		// Postings as 0.4.x wrote them, without Field tags.
		const untagged = process.env.CIS_SPARSE_UNTAGGED === "1";
		for (let start = 0; start < entries.length; start += 300)
			await t.run(async (ctx) => {
				for (const entry of entries.slice(start, start + 300)) {
					await ctx.db.insert("docs", { namespace: NS, ...entry, filters });
					for (const [gram, fields] of gramFieldsOf(entry.fields))
						await ctx.db.insert("postings", {
							namespace: NS,
							key: entry.key,
							sortKey: entry.sortKey,
							gram,
							g1: firstCodepoint(gram),
							...(untagged ? {} : { fields }),
						});
				}
			});
		const only = process.env.CIS_SPARSE_ONLY?.split(",");
		for (const [scenario, query, scope] of SCENARIOS) {
			if (only !== undefined && !only.includes(scenario)) continue;
			const expected = entries
				.toReversed()
				.filter((e) =>
					(scope ?? Object.keys(e.fields)).some((f) =>
						e.fields[f]!.includes(fold(query)),
					),
				)
				.map((e) => e.key);
			// Unscoped pages are filled: up to 5 calls until 20 hits.
			let pageHits = 0;
			let pageCalls = 0;
			const cost = {
				calls: 0,
				ranges: 0,
				rows: 0,
				bytes: 0,
				perCall: [] as number[][],
			};
			const keys: string[] = [];
			let cursor: string | null = null;
			let done = false;
			for (let call = 0; call < 400 && !done; call++) {
				await t.run(async (ctx) => {
					const b = await ctx.meta.getTransactionMetrics();
					const result = await ctx.runQuery(api.lib.search, {
						namespace: NS,
						query,
						filters,
						...(scope === null ? {} : { fields: [...scope] }),
						limit: scope === null ? 20 - pageHits : 20,
						budget: 512,
						cursor,
					});
					pageHits += result.page.length;
					pageCalls += 1;
					if (pageHits >= 20 || pageCalls >= 5) {
						pageHits = 0;
						pageCalls = 0;
					}
					const a = await ctx.meta.getTransactionMetrics();
					const call = [
						a.databaseQueries.used - b.databaseQueries.used,
						a.documentsRead.used - b.documentsRead.used,
						a.bytesRead.used - b.bytesRead.used,
						result.page.length,
					];
					cost.calls++;
					cost.ranges += call[0]!;
					cost.rows += call[1]!;
					cost.bytes += call[2]!;
					cost.perCall.push(call);
					keys.push(...result.page.map((hit) => hit.key));
					cursor = result.cursor;
					done = result.isDone;
				});
			}
			expect(keys).toEqual(expected);
			appendFileSync(
				process.env.CIS_SPARSE_OUT!,
				JSON.stringify({
					scenario,
					hits: keys.length,
					...cost,
					perCall: cost.perCall.length <= 4 ? cost.perCall : undefined,
				}) + "\n",
			);
		}
	},
);
