import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { checkedSearch } from "../shared/checkedLocalSearch.js";

const NS = "limits";

async function seed(t: ReturnType<typeof initConvexTest>) {
	for (let i = 0; i < 120; i++) {
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: `k${String(i).padStart(3, "0")}`,
			sortKey: i,
			fields: [
				{
					name: "no",
					value: `TR-2607${String(i % 30).padStart(2, "0")}-00${i % 7}`,
				},
				{ name: "memo", value: i % 9 === 0 ? "route ROUTE-ONLY" : "route" },
			],
		});
	}
}

/** Times the reader asked a hidden `limit`. */
let hidden = 0;

/**
 * Hides `limit` on every query object, as a backend without the operator
 * would. Query objects are their own iterators, so everything a method
 * returns is wrapped except promises.
 */
function withoutLimit<T extends object>(value: T): T {
	return new Proxy(value, {
		get(target, prop) {
			if (prop === "limit") {
				hidden += 1;
				return undefined;
			}
			const got = Reflect.get(target, prop, target);
			if (typeof got !== "function") return got;
			return (...args: unknown[]) => {
				const result = got.apply(target, args);
				return result !== null &&
					typeof result === "object" &&
					typeof (result as { then?: unknown }).then !== "function"
					? withoutLimit(result)
					: result;
			};
		},
	});
}

describe("query limits", () => {
	// The reader asks for `.limit(n)` on every range so Convex fetches only
	// the rows it expects to read. Convex's public types omit `limit` (it is
	// the operator `take` is built on), so pin it here: if an upgrade drops
	// it, this fails instead of silently going back to 100-row prefetches.
	test("Convex queries still have the limit operator", async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			const query = ctx.db
				.query("docs")
				.withIndex("by_ns_sort", (q) => q.eq("namespace", NS))
				.order("desc") as unknown as { limit?: unknown };
			expect(typeof query.limit).toBe("function");
		});
	});

	test("without the limit operator the reader returns the same pages", async () => {
		const t = initConvexTest();
		await seed(t);
		for (const [query, fields] of [
			["TR-260712", ["no"]],
			["ROUTE-ONLY", ["memo"]],
			["route", undefined],
		] as const) {
			const pages = async (strip: boolean) =>
				await t.run(async (ctx) => {
					const keys: string[][] = [];
					let cursor: string | null = null;
					for (let call = 0; call < 50; call++) {
						const c = strip
							? ({ ...ctx, db: withoutLimit(ctx.db) } as typeof ctx)
							: ctx;
						const result = await checkedSearch(c, {
							namespace: NS,
							query,
							...(fields ? { fields: [...fields] } : {}),
							cursor,
							limit: 7,
						});
						keys.push(result.page.map((hit) => hit.key));
						cursor = result.cursor;
						if (result.isDone) break;
					}
					return keys.flat();
				});
			hidden = 0;
			const stripped = await pages(true);
			expect(hidden).toBeGreaterThan(0);
			expect(stripped).toEqual(await pages(false));
		}
	});

	test("a range opened after an early exit from another still reads", async () => {
		const t = initConvexTest();
		await seed(t);
		await t.run(async (ctx) => {
			const range = ctx.db
				.query("docs")
				.withIndex("by_ns_sort", (q) => q.eq("namespace", NS))
				.order("desc");
			const first = range[Symbol.asyncIterator]();
			expect((await first.next()).done).toBe(false);
			await first.return?.();
			const rows = await ctx.db
				.query("docs")
				.withIndex("by_ns_sort", (q) => q.eq("namespace", NS))
				.order("desc")
				.take(3);
			expect(rows.map((doc) => doc.sortKey)).toEqual([119, 118, 117]);
		});
	});
});

describe("cursors across versions", () => {
	test("a cursor written before idle counts (`j`) still pages, and a bad `j` is ignored", async () => {
		const t = initConvexTest();
		await seed(t);
		const all = async (first: string | null) => {
			const keys: string[] = [];
			let cursor = first;
			for (let call = 0; call < 50; call++) {
				const result = await t.query(api.lib.search, {
					namespace: NS,
					query: "TR-2607",
					fields: ["no"],
					cursor,
					limit: 10,
				});
				keys.push(...result.page.map((hit) => hit.key));
				cursor = result.cursor;
				if (result.isDone) break;
			}
			return keys;
		};
		const fresh = await all(null);
		const tail = (cursor: string) =>
			fresh.filter((key) => Number(key.slice(1)) < JSON.parse(cursor).s);
		// 0.5.x cursors: a plan without `j`, a docs-mode cursor, no plan at all.
		for (const old of [
			JSON.stringify({ s: 60, k: "k060", g: ["tr", "r-", "-2", "26"] }),
			JSON.stringify({ s: 60, k: "k060", d: 1 }),
			JSON.stringify({ s: 60, k: "k060" }),
			JSON.stringify({ s: 60, k: "k060", g: ["tr", "r-"], j: [-1] }),
			JSON.stringify({ s: 60, k: "k060", g: ["tr", "r-"], j: [1, 2] }),
		])
			expect(await all(old)).toEqual(tail(old));
	});
});
