/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { TestConvex } from "convex-test";
import type schema from "./schema.js";
import { gramFieldsOf } from "../shared/grams.js";

const NS = "test";
type T = TestConvex<typeof schema>;

/** Strip the Field tags from `keys`' postings, as 0.4.x wrote them. */
async function untag(t: T, keys: string[]) {
	await t.run(async (ctx) => {
		for (const p of await ctx.db.query("postings").collect()) {
			if (!keys.includes(p.key)) continue;
			await ctx.db.replace("postings", p._id, {
				namespace: p.namespace,
				gram: p.gram,
				g1: p.g1,
				key: p.key,
				sortKey: p.sortKey,
			});
		}
	});
}

/** Postings whose tag differs from what their doc's fields give. */
async function wrongTags(t: T): Promise<string[]> {
	return await t.run(async (ctx) => {
		const wrong: string[] = [];
		for (const doc of await ctx.db.query("docs").collect()) {
			const want = gramFieldsOf(doc.fields);
			const rows = await ctx.db
				.query("postings")
				.withIndex("by_ns_key", (q) =>
					q.eq("namespace", doc.namespace).eq("key", doc.key),
				)
				.collect();
			for (const p of rows) {
				if (p.fields?.join() !== want.get(p.gram)?.join()) {
					wrong.push(`${p.key}:${p.gram}`);
				}
			}
			if (rows.length !== want.size) wrong.push(`${doc.key}:count`);
		}
		return wrong;
	});
}

async function retagAll(t: T, namespace = NS) {
	const calls: { cursor: string | null; retagged: number }[] = [];
	let cursor: string | null = null;
	do {
		const result: { cursor: string | null; retagged: number } =
			await t.mutation(api.lib.retagNamespace, { namespace, cursor });
		calls.push(result);
		cursor = result.cursor;
	} while (cursor !== null && calls.length < 100);
	return calls;
}

const fields = (no: string, memo: string) => [
	{ name: "no", value: no },
	{ name: "memo", value: memo },
];

describe("retagNamespace", () => {
	test("tags only the untagged Entries, from their stored fields, and leaves tagged rows alone", async () => {
		const t = initConvexTest();
		for (let i = 0; i < 6; i += 1) {
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: `k${i}`,
				fields: fields(`TR-${i}`, i % 2 === 0 ? "香港 route" : ""),
				sortKey: i,
				filters: { section: "pending" },
			});
		}
		await t.mutation(api.lib.set, {
			namespace: "other",
			key: "k0",
			fields: fields("TR-0", "x"),
			sortKey: 0,
		});
		await untag(t, ["k1", "k2", "k4"]);
		const tagged = await t.run(async (ctx) =>
			(await ctx.db.query("postings").collect())
				.filter((p) => p.fields !== undefined)
				.map((p) => `${p._id}@${p._creationTime}`)
				.sort(),
		);
		expect((await wrongTags(t)).length).toBeGreaterThan(0);

		const calls = await retagAll(t);
		expect(calls.at(-1)!.cursor).toBeNull();
		expect(calls.reduce((n, c) => n + c.retagged, 0)).toBe(3);
		expect(await wrongTags(t)).toEqual([]);
		// Rows that were already tagged keep their identity; docs are untouched.
		const after = await t.run(async (ctx) =>
			(await ctx.db.query("postings").collect()).map(
				(p) => `${p._id}@${p._creationTime}`,
			),
		);
		for (const row of tagged) expect(after).toContain(row);
		expect(
			await t.query(api.lib.get, { namespace: NS, key: "k2" }),
		).toMatchObject({ sortKey: 2, filters: { section: "pending" } });
		// A second pass finds nothing to do.
		const again = await retagAll(t);
		expect(again.reduce((n, c) => n + c.retagged, 0)).toBe(0);
		// Field-scoped search still finds the same Entries.
		const result = await t.query(api.lib.search, {
			namespace: NS,
			query: "香港",
			fields: ["memo"],
		});
		expect(result.page.map((hit) => hit.key)).toEqual(["k4", "k2", "k0"]);
	});

	test("an empty namespace and an Entry with no text finish in one call", async () => {
		const t = initConvexTest();
		expect(await retagAll(t)).toEqual([{ cursor: null, retagged: 0 }]);
		await t.mutation(api.lib.set, {
			namespace: NS,
			key: "empty",
			fields: fields("", ""),
			sortKey: 1,
		});
		expect(await retagAll(t)).toEqual([{ cursor: null, retagged: 0 }]);
	});

	test("a cursor resumes after its key", async () => {
		const t = initConvexTest();
		for (const key of ["a", "b", "c"]) {
			await t.mutation(api.lib.set, {
				namespace: NS,
				key,
				fields: fields(key + key, ""),
				sortKey: 1,
			});
		}
		await untag(t, ["a", "b", "c"]);
		const result = await t.mutation(api.lib.retagNamespace, {
			namespace: NS,
			cursor: "a",
		});
		expect(result).toEqual({ cursor: null, retagged: 2 });
		expect(await wrongTags(t)).toEqual(
			expect.arrayContaining([expect.stringMatching(/^a:/)]),
		);
		expect((await wrongTags(t)).every((row) => row.startsWith("a:"))).toBe(
			true,
		);
	});

	test("large untagged Entries split across calls, and a max-size one goes to the reaper", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const text = (offset: number, length: number) =>
				Array.from({ length }, (_, i) =>
					String.fromCodePoint(0x4e00 + offset + i),
				).join("");
			// Two 2000-gram Entries cannot share one call's REAP_BATCH writes.
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "a",
				fields: [{ name: "body", value: text(0, 2000) }],
				sortKey: 1,
			});
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "b",
				fields: [{ name: "body", value: text(3000, 2000) }],
				sortKey: 2,
			});
			await t.mutation(api.lib.set, {
				namespace: NS,
				key: "c",
				fields: [{ name: "body", value: text(6000, 4096) }],
				sortKey: 3,
			});
			await untag(t, ["a", "b", "c"]);
			const calls = await retagAll(t);
			expect(calls).toEqual([
				{ cursor: "b", retagged: 2 },
				{ cursor: null, retagged: 1 },
			]);
			const marks = () =>
				t.run(
					async (ctx) => (await ctx.db.query("retagging").collect()).length,
				);
			expect(await marks()).toBe(1);
			const hit = await t.query(api.lib.search, {
				namespace: NS,
				query: text(6000 + 2000, 3),
				fields: ["body"],
			});
			expect(hit.page.map((h) => h.key)).toEqual(["c"]);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await marks()).toBe(0);
			expect(await wrongTags(t)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	}, 60_000);
});
