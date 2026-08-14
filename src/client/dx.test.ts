import { describe, expect, test } from "vitest";
import { SearchIndex, findFoldedRange, matchSegments } from "./index.js";
import type { ComponentApi } from "./index.js";

/**
 * The DX layer is pure orchestration over the component boundary, so these
 * tests mock it: runQuery/runMutation capture calls, db.get serves a canned
 * table.
 */
const component = {
	lib: { search: "search", set: "set", remove: "remove", get: "get" },
} as unknown as ComponentApi;

type Note = { _id: string; note: string; createdAt: number; archived?: boolean };

function makeCtx(rows: Record<string, Note>) {
	const mutations: { ref: unknown; args: Record<string, unknown> }[] = [];
	let searchResult: unknown = { page: [], cursor: null, isDone: true };
	const ctx = {
		db: {
			get: async (_table: string, id: string) => rows[id] ?? null,
		},
		runQuery: async () => searchResult,
		runMutation: async (ref: unknown, args: Record<string, unknown>) => {
			mutations.push({ ref, args });
		},
	};
	return {
		ctx,
		mutations,
		setSearchResult: (r: unknown) => {
			searchResult = r;
		},
	};
}

function makeIndexer(rows: Record<string, Note>) {
	const index = new SearchIndex(component, { name: "notes" });
	const { ctx, mutations, setSearchResult } = makeCtx(rows);
	const indexer = index.tableIndexer<Note>({
		table: "notes",
		map: (_ctx, note) =>
			note.archived
				? null
				: {
						text: { note: note.note, ref: `N-${note.createdAt}` },
						sortKey: note.createdAt,
					},
	});
	return { index, indexer, ctx, mutations, setSearchResult };
}

describe("tableIndexer", () => {
	test("sync upserts a live document with the mapped multi-field entry", async () => {
		const { indexer, ctx, mutations } = makeIndexer({
			n1: { _id: "n1", note: "停車場費", createdAt: 5 },
		});
		await indexer.sync(ctx as never, "n1");
		expect(mutations).toHaveLength(1);
		expect(mutations[0].ref).toBe(component.lib.set);
		expect(mutations[0].args).toMatchObject({
			namespace: "notes",
			key: "n1",
			sortKey: 5,
			fields: [
				{ name: "note", value: "停車場費" },
				{ name: "ref", value: "N-5" },
			],
		});
	});

	test("sync removes when the document is gone or mapped to null", async () => {
		const { indexer, ctx, mutations } = makeIndexer({
			archived: { _id: "archived", note: "x", createdAt: 1, archived: true },
		});
		await indexer.sync(ctx as never, "deleted");
		await indexer.sync(ctx as never, "archived");
		expect(mutations.map((m) => m.ref)).toEqual([component.lib.remove, component.lib.remove]);
		expect(mutations.map((m) => m.args.key)).toEqual(["deleted", "archived"]);
	});

	test("a custom key function shapes every path, including removal by bare id", async () => {
		const index = new SearchIndex(component, { name: "receipts" });
		const { ctx, mutations } = makeCtx({ n1: { _id: "n1", note: "過磅", createdAt: 2 } });
		const indexer = index.tableIndexer<Note>({
			table: "notes",
			key: (id) => `driver:${id}`,
			map: (_ctx, note) => ({ text: note.note, sortKey: note.createdAt }),
		});
		await indexer.sync(ctx as never, "n1");
		expect(mutations[0].args.key).toBe("driver:n1");
		await indexer.sync(ctx as never, "gone");
		expect(mutations[1]).toMatchObject({ ref: component.lib.remove, args: { key: "driver:gone" } });
	});

	test("syncDoc skips the read; trigger delete removes by change id", async () => {
		const { indexer, ctx, mutations } = makeIndexer({});
		await indexer.syncDoc(ctx as never, { _id: "n9", note: "備註", createdAt: 9 });
		expect(mutations[0]).toMatchObject({ ref: component.lib.set, args: { key: "n9" } });
		const trigger = indexer.trigger();
		await trigger(ctx as never, { operation: "delete", id: "n9", oldDoc: null, newDoc: null });
		expect(mutations[1]).toMatchObject({ ref: component.lib.remove, args: { key: "n9" } });
		await expect(indexer.syncDoc(ctx as never, null)).rejects.toThrow(/id/);
	});
});

describe("searchDocs / searchPaginated", () => {
	test("hydrates hits from the table and drops dead keys", async () => {
		const { index, ctx, setSearchResult } = makeIndexer({
			n1: { _id: "n1", note: "停車場費", createdAt: 5 },
		});
		setSearchResult({
			page: [
				{ key: "n1", sortKey: 5, matchedFields: ["note"] },
				{ key: "gone", sortKey: 4, matchedFields: ["ref"] },
			],
			cursor: "c1",
			isDone: false,
		});
		const result = await index.searchDocs<Note>(ctx as never, { table: "notes", query: "停車" });
		expect(result.page).toEqual([
			{ doc: { _id: "n1", note: "停車場費", createdAt: 5 }, sortKey: 5, matchedFields: ["note"] },
		]);
		expect(result.cursor).toBe("c1");
		expect(result.isDone).toBe(false);
	});

	test("searchPaginated speaks the standard paginated shape", async () => {
		const { index, ctx, setSearchResult } = makeIndexer({});
		setSearchResult({ page: [], cursor: null, isDone: true });
		const done = await index.searchPaginated(ctx as never, {
			query: "x",
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(done).toEqual({ page: [], isDone: true, continueCursor: "" });
		setSearchResult({
			page: [{ key: "n1", sortKey: 5, matchedFields: ["note"] }],
			cursor: "c2",
			isDone: false,
		});
		const more = await index.searchPaginated(ctx as never, {
			query: "x",
			paginationOpts: { numItems: 1, cursor: "c1" },
		});
		expect(more.isDone).toBe(false);
		expect(more.continueCursor).toBe("c2");
	});
});

describe("highlight utilities", () => {
	test("locates folded matches across width and case", () => {
		expect(findFoldedRange("停車場月租 ＡＢＣ大樓", "abc")).toEqual([6, 9]);
		expect(matchSegments("停車場月租 ＡＢＣ大樓", "abc")).toEqual([
			{ text: "停車場月租 ", match: false },
			{ text: "ＡＢＣ", match: true },
			{ text: "大樓", match: false },
		]);
		expect(findFoldedRange("TR-260814-002", "tr-2608")).toEqual([0, 7]);
	});

	test("handles surrogate pairs at the match end", () => {
		// "\u{1D4B3}" folds to "x"; the highlight must cover both UTF-16 units.
		expect(findFoldedRange("貨物\u{1D4B3}標記", "物x")).toEqual([1, 4]);
	});

	test("returns null (whole text unhighlighted) when folding cannot be located", () => {
		// Decomposed n + combining tilde folds differently as a whole string;
		// the row still matches server-side — we just skip the highlight.
		expect(findFoldedRange("pin\u0303ata", "pi\u00f1a")).toBeNull();
		expect(matchSegments("pin\u0303ata", "pi\u00f1a")).toEqual([
			{ text: "pin\u0303ata", match: false },
		]);
	});

	test("empty query never highlights", () => {
		expect(findFoldedRange("abc", "")).toBeNull();
	});
});
