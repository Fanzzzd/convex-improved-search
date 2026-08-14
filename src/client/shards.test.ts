import { describe, expect, test } from "vitest";
import { ShardedSearchIndex } from "./index.js";
import type { ComponentApi } from "./index.js";

/**
 * The sharded search is pure orchestration over per-shard component calls,
 * so these tests mock the component boundary: a faithful in-memory stand-in
 * for lib.search (substring filter, sortKey-desc order, offset cursor).
 */
const component = {
	lib: { search: "search", set: "set", remove: "remove" },
} as unknown as ComponentApi;

type Row = { key: string; sortKey: number; text: string };

function makeCtx(corpus: Record<string, Row[]>) {
	const calls: { namespace: string; cursor: string | null | undefined }[] = [];
	const ctx = {
		runQuery: async (_ref: unknown, args: Record<string, unknown>) => {
			const namespace = args.namespace as string;
			calls.push({ namespace, cursor: args.cursor as string | null | undefined });
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
	return { ctx, calls };
}

function makeIndex() {
	return new ShardedSearchIndex(component, { name: "receipts" });
}

async function drain(
	index: ShardedSearchIndex,
	ctx: { runQuery: (ref: unknown, args: Record<string, unknown>) => Promise<unknown> },
	args: { shards: readonly string[]; query: string; limit?: number; budget?: number },
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
		// Default budget visits at most 3 shards per call → 5 empty shards need 2 calls.
		expect(calls.length).toBe(5);
	});
});

describe("sharded trigger", () => {
	type Doc = { _id: string; note: string; createdAt: number; archived?: boolean };

	function makeTrigger() {
		const index = new ShardedSearchIndex(component, { name: "receipts" });
		const mutations: { ref: unknown; args: Record<string, unknown> }[] = [];
		const ctx = {
			runMutation: async (ref: unknown, args: Record<string, unknown>) => {
				mutations.push({ ref, args });
			},
		};
		const trigger = index.trigger<Doc>((doc) =>
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
		expect(mutations[0].args).toMatchObject({ namespace: "receipts/new", key: "r1" });
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
		expect(mutations[0].args).toMatchObject({ namespace: "receipts/new", text: "停車場" });
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
		expect(mutations[0].args).toMatchObject({ namespace: "receipts/old", key: "r1" });
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
