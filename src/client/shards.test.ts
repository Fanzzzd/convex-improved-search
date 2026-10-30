import { describe, expect, test } from "vitest";
import { ShardedSearchIndex } from "./index.js";
import type { ComponentApi } from "./index.js";

/**
 * The sharded search is pure orchestration over per-shard component calls,
 * so these tests mock the component boundary: a faithful in-memory stand-in
 * for lib.search (substring filter, sortKey-desc order, offset cursor).
 */
const component = {
	lib: {
		search: "search",
		set: "set",
		remove: "remove",
		namespaceBefore: "namespaceBefore",
	},
} as unknown as ComponentApi;

type Row = { key: string; sortKey: number; text: string };

function makeCtx(corpus: Record<string, Row[]>) {
	const calls: {
		namespace: string;
		cursor: string | null | undefined;
		limit: number | undefined;
		budget: number | undefined;
		fields: string[] | undefined;
	}[] = [];
	// The `before` of every namespaceBefore lookup.
	const lookups: (string | undefined)[] = [];
	const ctx = {
		runQuery: async (ref: unknown, args: Record<string, unknown>) => {
			if (ref === "namespaceBefore") {
				// The component's rule: greatest nonempty namespace with the prefix, below `before`.
				const prefix = args.prefix as string;
				const before = args.before as string | undefined;
				const below = Object.keys(corpus)
					.filter(
						(ns) =>
							ns.startsWith(prefix) &&
							(before === undefined || ns < before) &&
							corpus[ns].length > 0,
					)
					.sort();
				lookups.push(before);
				return below.at(-1) ?? null;
			}
			const namespace = args.namespace as string;
			calls.push({
				namespace,
				cursor: args.cursor as string | null | undefined,
				limit: args.limit as number | undefined,
				budget: args.budget as number | undefined,
				fields: args.fields as string[] | undefined,
			});
			const rows = (corpus[namespace] ?? [])
				.filter((r) => r.text.includes(args.query as string))
				.sort((a, b) => b.sortKey - a.sortKey || (a.key < b.key ? 1 : -1));
			const start = args.cursor == null ? 0 : Number(args.cursor);
			const limit = (args.limit as number | undefined) ?? 50;
			const page = rows
				.slice(start, start + limit)
				.map(({ key, sortKey }) => ({ key, sortKey }));
			const next = start + page.length;
			const isDone = next >= rows.length;
			return { page, cursor: isDone ? null : String(next), isDone };
		},
	};
	return { ctx, calls, lookups };
}

function makeIndex() {
	return new ShardedSearchIndex(component, { name: "receipts" });
}

async function drain(
	index: ShardedSearchIndex,
	ctx: {
		runQuery: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
	},
	args: {
		shards?: readonly string[];
		query: string;
		fields?: readonly string[];
		limit?: number;
		budget?: number;
	},
) {
	const keys: string[] = [];
	let previousSort = Infinity;
	let cursor: string | null = null;
	for (let round = 0; round < 100; round++) {
		const result = await index.search(ctx as never, { ...args, cursor });
		for (const row of result.page) {
			expect(row.sortKey).toBeLessThanOrEqual(previousSort);
			previousSort = row.sortKey;
			keys.push(row.key);
		}
		if (result.isDone) {
			expect(result.cursor).toBeNull();
			return keys;
		}
		cursor = result.cursor;
		expect(cursor).not.toBeNull();
	}
	throw new Error("sharded search did not terminate");
}

const quarters: Record<string, Row[]> = {
	// Shards partition the sortKey range, newest first — the time-shard contract.
	"receipts/2026Q3": Array.from({ length: 7 }, (_, i) => ({
		key: `q3-${i}`,
		sortKey: 300 - i,
		text: `Q3 停車場小票 ${i}`,
	})),
	"receipts/2026Q2": Array.from({ length: 5 }, (_, i) => ({
		key: `q2-${i}`,
		sortKey: 200 - i,
		text: `Q2 停車場小票 ${i}`,
	})),
	"receipts/2026Q1": [{ key: "q1-0", sortKey: 100, text: "Q1 過磅費" }],
};

describe("sharded search", () => {
	test("drains shards in order with globally descending sortKeys", async () => {
		const { ctx } = makeCtx(quarters);
		const keys = await drain(makeIndex(), ctx, {
			shards: ["2026Q3", "2026Q2", "2026Q1"],
			query: "停車",
			limit: 4,
		});
		expect(keys).toEqual([
			...Array.from({ length: 7 }, (_, i) => `q3-${i}`),
			...Array.from({ length: 5 }, (_, i) => `q2-${i}`),
		]);
	});

	test("a page can span a shard boundary", async () => {
		const { ctx } = makeCtx(quarters);
		const index = makeIndex();
		const first = await index.search(ctx as never, {
			shards: ["2026Q3", "2026Q2", "2026Q1"],
			query: "小票",
			limit: 10,
		});
		expect(first.page.map((r) => r.key)).toEqual([
			...Array.from({ length: 7 }, (_, i) => `q3-${i}`),
			...Array.from({ length: 3 }, (_, i) => `q2-${i}`),
		]);
		expect(first.isDone).toBe(false);
	});

	test("a new newest shard may appear between pages; the cursor still resolves", async () => {
		const { ctx } = makeCtx(quarters);
		const index = makeIndex();
		const first = await index.search(ctx as never, {
			shards: ["2026Q2", "2026Q1"],
			query: "停車",
			limit: 3,
		});
		expect(first.isDone).toBe(false);
		// 2026Q3 got created by an insert; the in-flight cursor keeps working.
		const second = await index.search(ctx as never, {
			shards: ["2026Q3", "2026Q2", "2026Q1"],
			query: "停車",
			cursor: first.cursor,
			limit: 10,
		});
		expect(second.page.map((r) => r.key)).toEqual(["q2-3", "q2-4"]);
		expect(second.isDone).toBe(true);
	});

	test("a cursor into a shard missing from the list throws", async () => {
		const { ctx } = makeCtx(quarters);
		const index = makeIndex();
		const first = await index.search(ctx as never, {
			shards: ["2026Q3"],
			query: "停車",
			limit: 2,
		});
		await expect(
			index.search(ctx as never, {
				shards: ["2026Q2"],
				query: "停車",
				cursor: first.cursor,
			}),
		).rejects.toThrow(/not in the shard list/);
	});

	test("empty shards are skipped, a few per call, without losing termination", async () => {
		const { ctx, calls } = makeCtx({});
		const shards = ["a", "b", "c", "d", "e"];
		const keys = await drain(makeIndex(), ctx, { shards, query: "x" });
		expect(keys).toEqual([]);
		// At most 4 shards per call → 5 empty shards need 2 calls.
		expect(calls.length).toBe(5);
	});

	test("visits at most CALLS_PER_TRANSACTION shards per call, each with the effective child budget", async () => {
		const { ctx, calls } = makeCtx({});
		const shards = Array.from({ length: 8 }, (_, i) => `s${i}`);
		const first = await makeIndex().search(ctx as never, {
			shards,
			query: "x",
			limit: 200,
			budget: 1,
		});
		expect(first.isDone).toBe(false);
		expect(calls).toHaveLength(4);
		expect(calls.every((call) => call.budget === 200)).toBe(true);
	});

	test("passes fields to every shard", async () => {
		const { ctx, calls } = makeCtx({});
		await drain(makeIndex(), ctx, {
			shards: ["a", "b"],
			query: "x",
			fields: ["no"],
		});
		expect(calls.map((call) => call.fields)).toEqual([["no"], ["no"]]);
	});

	test.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects non-finite sharded controls (%s)",
		async (value) => {
			const { ctx } = makeCtx({});
			await expect(
				makeIndex().search(ctx as never, {
					shards: ["s"],
					query: "x",
					limit: value,
				}),
			).rejects.toThrow(/finite number/);
		},
	);
});

describe("sharded trigger", () => {
	type Doc = {
		_id: string;
		note: string;
		createdAt: number;
		archived?: boolean;
	};

	function makeTrigger() {
		const index = new ShardedSearchIndex(component, { name: "receipts" });
		const mutations: { ref: unknown; args: Record<string, unknown> }[] = [];
		const ctx = {
			runMutation: async (ref: unknown, args: Record<string, unknown>) => {
				mutations.push({ ref, args });
			},
		};
		const trigger = index.trigger<Doc>((_ctx, doc) =>
			doc.archived
				? null
				: {
						key: doc._id,
						text: doc.note,
						sortKey: doc.createdAt,
						shard: doc.createdAt < 100 ? "old" : "new",
					},
		);
		return { trigger, ctx, mutations };
	}

	test("insert indexes into the mapped shard", async () => {
		const { trigger, ctx, mutations } = makeTrigger();
		const doc: Doc = { _id: "r1", note: "停車", createdAt: 150 };
		await trigger(ctx as never, {
			operation: "insert",
			id: "r1",
			oldDoc: null,
			newDoc: doc,
		});
		expect(mutations).toHaveLength(1);
		expect(mutations[0].args).toMatchObject({
			namespace: "receipts/new",
			key: "r1",
		});
	});

	test("update within a shard is a single set", async () => {
		const { trigger, ctx, mutations } = makeTrigger();
		await trigger(ctx as never, {
			operation: "update",
			id: "r1",
			oldDoc: { _id: "r1", note: "停車", createdAt: 150 },
			newDoc: { _id: "r1", note: "停車場", createdAt: 150 },
		});
		expect(mutations).toHaveLength(1);
		expect(mutations[0].args).toMatchObject({
			namespace: "receipts/new",
			fields: [{ name: "text", value: "停車場" }],
		});
	});

	test("a shard move removes from the old shard and sets in the new", async () => {
		const { trigger, ctx, mutations } = makeTrigger();
		await trigger(ctx as never, {
			operation: "update",
			id: "r1",
			oldDoc: { _id: "r1", note: "停車", createdAt: 50 },
			newDoc: { _id: "r1", note: "停車", createdAt: 150 },
		});
		expect(mutations.map((m) => m.args.namespace)).toEqual([
			"receipts/old",
			"receipts/new",
		]);
		expect(mutations[0].ref).toBe(component.lib.remove);
		expect(mutations[1].ref).toBe(component.lib.set);
	});

	test("delete removes from the shard the old doc mapped to", async () => {
		const { trigger, ctx, mutations } = makeTrigger();
		await trigger(ctx as never, {
			operation: "delete",
			id: "r1",
			oldDoc: { _id: "r1", note: "停車", createdAt: 50 },
			newDoc: null,
		});
		expect(mutations).toHaveLength(1);
		expect(mutations[0].ref).toBe(component.lib.remove);
		expect(mutations[0].args).toMatchObject({
			namespace: "receipts/old",
			key: "r1",
		});
	});

	test("archiving (mapper returns null) removes; archived docs never index", async () => {
		const { trigger, ctx, mutations } = makeTrigger();
		await trigger(ctx as never, {
			operation: "update",
			id: "r1",
			oldDoc: { _id: "r1", note: "停車", createdAt: 150 },
			newDoc: { _id: "r1", note: "停車", createdAt: 150, archived: true },
		});
		expect(mutations).toHaveLength(1);
		expect(mutations[0].ref).toBe(component.lib.remove);
		// and an archived insert is a no-op
		mutations.length = 0;
		await trigger(ctx as never, {
			operation: "insert",
			id: "r2",
			oldDoc: null,
			newDoc: { _id: "r2", note: "停車", createdAt: 150, archived: true },
		});
		expect(mutations).toHaveLength(0);
	});
});

describe("dated shards", () => {
	const at = (y: number, m: number, d = 1, ms = 0) =>
		Date.UTC(y, m - 1, d) + ms;

	function dated(period: "month" | "quarter" | "year") {
		return new ShardedSearchIndex(component, { name: "receipts", period });
	}

	test("a shard is the UTC period of the sortKey", () => {
		const lastMs = at(2026, 7, 1, -1); // 2026-06-30T23:59:59.999Z
		expect(dated("month").shardOf(lastMs)).toBe("2026-06");
		expect(dated("month").shardOf(lastMs + 1)).toBe("2026-07");
		expect(dated("quarter").shardOf(lastMs)).toBe("2026Q2");
		expect(dated("quarter").shardOf(lastMs + 1)).toBe("2026Q3");
		expect(dated("quarter").shardOf(at(2026, 12, 31))).toBe("2026Q4");
		expect(dated("year").shardOf(at(2026, 1, 1, -1))).toBe("2025");
	});

	test("shardsBetween lists periods newest first, across years", () => {
		expect(
			dated("month").shardsBetween(at(2026, 2, 3), at(2025, 11, 30)),
		).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
		expect(
			dated("quarter").shardsBetween(at(2026, 4, 1), at(2025, 12, 31)),
		).toEqual(["2026Q2", "2026Q1", "2025Q4"]);
		expect(dated("year").shardsBetween(at(2026, 5, 1), at(2026, 1, 1))).toEqual(
			["2026"],
		);
	});

	test("sortKeys that are not four-digit-year timestamps throw", () => {
		const index = dated("month");
		for (const bad of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Date.UTC(999, 0),
		]) {
			expect(() => index.shardOf(bad)).toThrow(/ms since epoch/);
		}
		expect(() => makeIndex().shardOf(0)).toThrow(/needs a `period`/);
	});

	test("set derives the shard and rejects one that disagrees with the sortKey", async () => {
		const index = dated("quarter");
		const mutations: Record<string, unknown>[] = [];
		const ctx = {
			runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
				mutations.push(args);
			},
		};
		await index.set(ctx as never, {
			key: "r1",
			text: "停車",
			sortKey: at(2026, 8, 9),
		});
		expect(mutations[0]).toMatchObject({
			namespace: "receipts/2026Q3",
			key: "r1",
		});
		await expect(
			index.set(ctx as never, {
				key: "r2",
				text: "停車",
				sortKey: at(2026, 8, 9),
				shard: "2026Q2",
			}),
		).rejects.toThrow(/belongs in shard "2026Q3"/);
		await index.remove(ctx as never, { key: "r1", sortKey: at(2026, 8, 9) });
		expect(mutations[1]).toMatchObject({
			namespace: "receipts/2026Q3",
			key: "r1",
		});
		await expect(
			makeIndex().set(ctx as never, { key: "r3", text: "x", sortKey: 1 }),
		).rejects.toThrow(/needs the entry's `shard`/);
	});

	test("the trigger moves an Entry whose sortKey crosses a period", async () => {
		const index = dated("month");
		const mutations: { ref: unknown; namespace: unknown }[] = [];
		const ctx = {
			runMutation: async (ref: unknown, args: Record<string, unknown>) => {
				mutations.push({ ref, namespace: args.namespace });
			},
		};
		const trigger = index.trigger<{
			_id: string;
			note: string;
			createdAt: number;
		}>((_ctx, doc) => ({
			key: doc._id,
			text: doc.note,
			sortKey: doc.createdAt,
		}));
		await trigger(ctx as never, {
			operation: "update",
			id: "r1",
			oldDoc: { _id: "r1", note: "停車", createdAt: at(2026, 7, 31) },
			newDoc: { _id: "r1", note: "停車", createdAt: at(2026, 8, 1) },
		});
		expect(mutations).toEqual([
			{ ref: component.lib.remove, namespace: "receipts/2026-07" },
			{ ref: component.lib.set, namespace: "receipts/2026-08" },
		]);
	});

	const corpus: Record<string, Row[]> = {
		...quarters,
		// Shards with no Entries are never visited.
		"receipts/2025Q4": [],
		// Another index under the same prefix is not a shard.
		"receipts/archive": [{ key: "a-0", sortKey: 999, text: "停車" }],
		// Nor is a sibling index whose name starts the same way.
		receiptsX: [{ key: "x-0", sortKey: 998, text: "停車" }],
		"receipts2/2026Q4": [{ key: "x-1", sortKey: 997, text: "停車" }],
	};

	test("without `shards`, search visits every shard that holds Entries, newest first", async () => {
		const { ctx } = makeCtx(corpus);
		const index = dated("quarter");
		for (const limit of [1, 4, 50]) {
			const found = await drain(index, ctx, { query: "停車", limit });
			const listed = await drain(index, ctx, {
				shards: ["2026Q3", "2026Q2", "2026Q1"],
				query: "停車",
				limit,
			});
			expect(found).toEqual(listed);
			expect(found).toHaveLength(12);
		}
	});

	test("each step to an older shard costs one lookup", async () => {
		const { ctx, calls, lookups } = makeCtx(corpus);
		const keys = await drain(dated("quarter"), ctx, { query: "過磅" });
		expect(keys).toEqual(["q1-0"]);
		expect(calls.map((call) => call.namespace)).toEqual([
			"receipts/2026Q3",
			"receipts/2026Q2",
			"receipts/2026Q1",
		]);
		// First shard, then one after each shard; "archive" sorts above the
		// shards and is skipped with one extra lookup.
		expect(lookups).toEqual([
			undefined,
			"receipts/archive",
			"receipts/2026Q3",
			"receipts/2026Q2",
			"receipts/2026Q1",
		]);
	});

	test("unrelated namespaces spend the visit budget and resume without being searched", async () => {
		const unrelated = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [
				`receipts/z${String(i).padStart(3, "0")}`,
				[{ key: `other-${i}`, sortKey: 999, text: "停車" }],
			]),
		);
		const { ctx, calls, lookups } = makeCtx({ ...quarters, ...unrelated });
		const index = dated("quarter");
		const first = await index.search(ctx as never, { query: "停車" });
		expect(first.page).toEqual([]);
		expect(first.isDone).toBe(false);
		expect(first.cursor).not.toBeNull();
		expect(calls).toHaveLength(0);
		expect(lookups.length).toBeLessThanOrEqual(5);
		let cursor = first.cursor;
		const keys: string[] = [];
		for (let i = 0; i < 10; i += 1) {
			const before = lookups.length;
			const result = await index.search(ctx as never, {
				query: "停車",
				cursor,
			});
			expect(lookups.length - before).toBeLessThanOrEqual(4);
			keys.push(...result.page.map((hit) => hit.key));
			if (result.isDone) {
				expect(result.cursor).toBeNull();
				cursor = null;
				break;
			}
			expect(result.cursor).not.toBe(cursor);
			cursor = result.cursor;
		}
		expect(cursor).toBeNull();
		expect(keys).toEqual([
			...quarters["receipts/2026Q3"].map((row) => row.key),
			...quarters["receipts/2026Q2"].map((row) => row.key),
		]);
		expect(calls.every((call) => !call.namespace.includes("/z"))).toBe(true);
	});

	test("duplicate explicit shard names are rejected before reading", async () => {
		const { ctx, calls, lookups } = makeCtx({});
		await expect(
			makeIndex().search(ctx as never, { query: "x", shards: ["a", "a", "b"] }),
		).rejects.toThrow(/unique shard names/);
		expect(calls).toHaveLength(0);
		expect(lookups).toHaveLength(0);
	});

	test("search without `shards` or a `period` throws", async () => {
		const { ctx } = makeCtx(corpus);
		await expect(
			makeIndex().search(ctx as never, { query: "x" }),
		).rejects.toThrow(/needs a `period`/);
	});
});
