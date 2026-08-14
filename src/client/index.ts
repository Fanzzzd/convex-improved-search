import type {
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

export { MAX_TEXT_LENGTH, fold } from "../component/grams.js";

/** Exact-match filter values. `null` is a real value; an absent field matches nothing. */
export type FilterValue = string | number | boolean | null;

export type SearchResultPage = {
	page: { key: string; sortKey: number }[];
	/**
	 * Pass back to keep paging. IMPORTANT: a non-null cursor with a short (or
	 * even empty) page means the scan budget ran out before the page filled —
	 * keep paging and matches keep arriving. Only `isDone: true` means the
	 * search is exhausted.
	 */
	cursor: string | null;
	isDone: boolean;
};

export type IndexEntry<Filter extends string = never> = {
	/** Identifier of the indexed document — typically your doc's `_id`. */
	key: string;
	/** The searchable text. Folded (NFKC + lowercase) and bigram-indexed. */
	text: string;
	/** Results are ordered by sortKey descending — typically a creation timestamp. */
	sortKey: number;
	filters?: Partial<Record<Filter, FilterValue>>;
	/** Behavior when the folded text exceeds MAX_TEXT_LENGTH codepoints. Default "truncate". */
	onOverflow?: "truncate" | "error";
};

type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type RunMutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;

/** Drop `undefined` entries (allowed by Partial<>) — the wire format has real values only. */
function compactFilters(
	filters: Partial<Record<string, FilterValue>> | undefined,
): Record<string, FilterValue> | undefined {
	if (filters === undefined) return undefined;
	const entries = Object.entries(filters).filter(
		(entry): entry is [string, FilterValue] => entry[1] !== undefined,
	);
	return Object.fromEntries(entries);
}

/** The change shape produced by `convex-helpers/server/triggers` (structural — no hard dependency). */
type TriggerChange<D> = {
	operation: "insert" | "update" | "delete";
	id: string;
	oldDoc: D | null;
	newDoc: D | null;
};

/**
 * One search index over one logical collection.
 *
 * ```ts
 * // convex/searchIndexes.ts
 * import { SearchIndex } from "convex-improved-search";
 * import { components } from "./_generated/api";
 *
 * export const receipts = new SearchIndex(components.improvedSearch, {
 *   name: "receipts",
 *   filterFields: ["source", "category"],
 * });
 *
 * // In your mutations (same transaction as your own writes):
 * await receipts.set(ctx, {
 *   key: doc._id,
 *   text: buildSearchText(doc),
 *   sortKey: doc.createdAt,
 *   filters: { source: "freight", category: doc.type },
 * });
 *
 * // In your queries (reactive like any Convex query):
 * const { page, cursor, isDone } = await receipts.search(ctx, {
 *   query: "停車",
 *   filters: { category: "parking" },
 * });
 * ```
 */
export class SearchIndex<Filter extends string = never> {
	constructor(
		private readonly component: ComponentApi,
		private readonly options: {
			/** Namespace inside the component. One name per logical collection. */
			name: string;
			/**
			 * Exact-match filter field names, for typing only — misspelled
			 * fields in `set`/`search` become compile errors.
			 */
			filterFields?: readonly Filter[];
		},
	) {}

	/** Insert or replace one document in the index. Idempotent; edits pay only the gram diff. */
	async set(ctx: RunMutationCtx, entry: IndexEntry<Filter>): Promise<void> {
		await ctx.runMutation(this.component.lib.set, {
			namespace: this.options.name,
			key: entry.key,
			text: entry.text,
			sortKey: entry.sortKey,
			filters: compactFilters(entry.filters),
			onOverflow: entry.onOverflow,
		});
	}

	/** Remove one document from the index. No-op when absent. */
	async remove(ctx: RunMutationCtx, args: { key: string }): Promise<void> {
		await ctx.runMutation(this.component.lib.remove, {
			namespace: this.options.name,
			key: args.key,
		});
	}

	/**
	 * Exact substring search over the index, newest first.
	 * The result set is exactly `docs.filter((d) => fold(d.text).includes(fold(query)))`
	 * — the inverted index only accelerates, never approximates.
	 */
	async search(
		ctx: RunQueryCtx,
		args: {
			query: string;
			filters?: Partial<Record<Filter, FilterValue>>;
			cursor?: string | null;
			limit?: number;
			/** Max candidate postings scanned this call. Raise for very selective filters. */
			budget?: number;
		},
	): Promise<SearchResultPage> {
		return await ctx.runQuery(this.component.lib.search, {
			namespace: this.options.name,
			query: args.query,
			filters: compactFilters(args.filters),
			cursor: args.cursor,
			limit: args.limit,
			budget: args.budget,
		});
	}

	/** What the index believes about one key (drift inspection for reconcile recipes). */
	async get(
		ctx: RunQueryCtx,
		args: { key: string },
	): Promise<{
		foldedText: string;
		sortKey: number;
		filters?: Record<string, FilterValue>;
	} | null> {
		return await ctx.runQuery(this.component.lib.get, {
			namespace: this.options.name,
			key: args.key,
		});
	}

	/**
	 * Delete one batch of the index. Loop until the returned cursor is null:
	 *
	 * ```ts
	 * let cursor: string | null = null;
	 * do { ({ cursor } = await receipts.clear(ctx, { cursor })); } while (cursor !== null);
	 * ```
	 * (Run the loop across scheduled mutations for large namespaces.)
	 */
	async clear(
		ctx: RunMutationCtx,
		args?: { cursor?: string | null },
	): Promise<{ cursor: string | null }> {
		return await ctx.runMutation(this.component.lib.clearNamespace, {
			namespace: this.options.name,
			cursor: args?.cursor,
		});
	}

	/**
	 * A trigger for `convex-helpers/server/triggers`, keeping the index in
	 * sync atomically with the table it watches:
	 *
	 * ```ts
	 * const triggers = new Triggers<DataModel>();
	 * triggers.register("feeEntries", receipts.trigger((doc) => ({
	 *   key: doc._id,
	 *   text: doc.note ?? "",
	 *   sortKey: doc.createdAt,
	 * })));
	 * ```
	 *
	 * Return `null` from the mapper to keep a document out of the index
	 * (e.g. archived rows) — it is then removed under its default key
	 * (`doc._id`). When you use custom keys AND conditional indexing, handle
	 * removal yourself instead of returning null.
	 */
	trigger<D extends { _id: string }>(
		map: (doc: D) => IndexEntry<Filter> | null,
	): (ctx: RunMutationCtx, change: TriggerChange<D>) => Promise<void> {
		return async (ctx, change) => {
			if (change.operation === "delete") {
				const oldEntry = change.oldDoc === null ? null : map(change.oldDoc);
				const key = oldEntry?.key ?? change.oldDoc?._id ?? change.id;
				await this.remove(ctx, { key });
				return;
			}
			const doc = change.newDoc;
			if (doc === null) return;
			const entry = map(doc);
			if (entry === null) {
				await this.remove(ctx, { key: doc._id });
				return;
			}
			await this.set(ctx, entry);
		};
	}
}

export type { ComponentApi };
