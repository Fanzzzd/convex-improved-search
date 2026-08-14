import type {
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

export { MAX_TEXT_LENGTH, fold } from "../component/grams.js";

/** Exact-match filter values. `null` is a real value; an absent field matches nothing. */
export type FilterValue = string | number | boolean | null;

/** Mirror the component's defaults (used for sharded-search bookkeeping only). */
const DEFAULT_LIMIT = 50;
const DEFAULT_SCAN_BUDGET = 256;

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

/** An IndexEntry that also names the time shard (or any partition) it lives in. */
export type ShardedIndexEntry<Filter extends string = never> = IndexEntry<Filter> & {
	/** Shard name, e.g. "2026Q3". Must be derivable from the document alone. */
	shard: string;
};

type ShardCursor = { shard: string; inner: string | null };

/**
 * Time-sharded search: one SearchIndex per shard, all under one logical name.
 *
 * A shard is nothing but a namespace convention (`${name}/${shard}`), so
 * shards can be created lazily (indexing into a new quarter just works) and
 * pre-built ahead of a cutover with the normal backfill recipe. Search
 * drains shards sequentially in the order given, so results are globally
 * newest-first exactly when the shard list is ordered newest-first and the
 * shards partition the sortKey range (the natural situation when the shard
 * is derived from the sortKey, e.g. quarter of `createdAt`).
 *
 * ```ts
 * export const receipts = new ShardedSearchIndex(components.improvedSearch, {
 *   name: "receipts",
 *   filterFields: ["source"],
 * });
 * const shardOf = (createdAt: number) => {
 *   const d = new Date(createdAt);
 *   return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
 * };
 *
 * // Writes: triggers.register("receipts", receipts.trigger((doc) => ({
 * //   key: doc._id, text: doc.note, sortKey: doc.createdAt,
 * //   shard: shardOf(doc.createdAt),
 * // })));
 *
 * // Reads: pass the live shard list, newest first.
 * const result = await receipts.search(ctx, {
 *   shards: ["2026Q3", "2026Q2", "2026Q1"],
 *   query: "停車",
 * });
 * ```
 */
export class ShardedSearchIndex<Filter extends string = never> {
	private readonly shardIndexes = new Map<string, SearchIndex<Filter>>();

	constructor(
		private readonly component: ComponentApi,
		private readonly options: {
			/** Logical collection name; shard s lives in namespace `${name}/${s}`. */
			name: string;
			/** Exact-match filter field names, for typing only. */
			filterFields?: readonly Filter[];
		},
	) {}

	/** The SearchIndex for one shard — full API (set/remove/get/clear/search). */
	shard(shardName: string): SearchIndex<Filter> {
		let index = this.shardIndexes.get(shardName);
		if (index === undefined) {
			index = new SearchIndex(this.component, {
				name: `${this.options.name}/${shardName}`,
				filterFields: this.options.filterFields,
			});
			this.shardIndexes.set(shardName, index);
		}
		return index;
	}

	/** Insert or replace one document in its shard. */
	async set(ctx: RunMutationCtx, entry: ShardedIndexEntry<Filter>): Promise<void> {
		const { shard, ...rest } = entry;
		await this.shard(shard).set(ctx, rest);
	}

	/** Remove one document from the named shard. */
	async remove(
		ctx: RunMutationCtx,
		args: { shard: string; key: string },
	): Promise<void> {
		await this.shard(args.shard).remove(ctx, { key: args.key });
	}

	/**
	 * Search across shards, in the given order. Same paging contract as
	 * SearchIndex.search: a short or empty page with a non-null cursor means
	 * "keep paging". The per-call `budget` applies to each shard visited, so
	 * one call visits at most a few shards; the cursor carries progress.
	 */
	async search(
		ctx: RunQueryCtx,
		args: {
			/** Live shard list, newest first. May grow between calls; a shard named by an in-flight cursor must still be present. */
			shards: readonly string[];
			query: string;
			filters?: Partial<Record<Filter, FilterValue>>;
			cursor?: string | null;
			limit?: number;
			budget?: number;
		},
	): Promise<SearchResultPage> {
		const limit = args.limit ?? DEFAULT_LIMIT;
		let start = 0;
		let inner: string | null = null;
		if (args.cursor != null) {
			let parsed: ShardCursor;
			try {
				parsed = JSON.parse(args.cursor) as ShardCursor;
				if (typeof parsed.shard !== "string") throw new Error("bad shape");
			} catch {
				throw new Error("Invalid sharded search cursor");
			}
			start = args.shards.indexOf(parsed.shard);
			if (start === -1) {
				throw new Error(
					`Sharded search cursor points at "${parsed.shard}", which is not in the shard list`,
				);
			}
			inner = parsed.inner;
		}

		// Each drained shard can cost up to ~budget*4 reads inside the shared
		// transaction, so bound the shards visited per call accordingly.
		const budget = args.budget ?? DEFAULT_SCAN_BUDGET;
		const maxShards = Math.max(1, Math.min(8, Math.floor(3072 / (budget * 4))));

		const page: SearchResultPage["page"] = [];
		for (let i = start; i < args.shards.length; i += 1) {
			if (i - start >= maxShards) {
				return {
					page,
					cursor: JSON.stringify({ shard: args.shards[i], inner: null }),
					isDone: false,
				};
			}
			const result = await this.shard(args.shards[i]).search(ctx, {
				query: args.query,
				filters: args.filters,
				cursor: i === start ? inner : null,
				limit: limit - page.length,
				budget: args.budget,
			});
			page.push(...result.page);
			if (!result.isDone) {
				return {
					page,
					cursor: JSON.stringify({ shard: args.shards[i], inner: result.cursor }),
					isDone: false,
				};
			}
			if (page.length >= limit && i + 1 < args.shards.length) {
				return {
					page,
					cursor: JSON.stringify({ shard: args.shards[i + 1], inner: null }),
					isDone: false,
				};
			}
		}
		return { page, cursor: null, isDone: true };
	}

	/**
	 * A trigger for `convex-helpers/server/triggers`. The mapper names the
	 * shard, so the trigger can move a document between shards when the
	 * mapped shard changes, and knows which shard to delete from. A `null`
	 * mapping means "not indexed" — with a deterministic mapper there is
	 * nothing to remove either.
	 */
	trigger<D extends { _id: string }>(
		map: (doc: D) => ShardedIndexEntry<Filter> | null,
	): (ctx: RunMutationCtx, change: TriggerChange<D>) => Promise<void> {
		return async (ctx, change) => {
			const oldEntry = change.oldDoc === null ? null : map(change.oldDoc);
			const newEntry = change.newDoc === null ? null : map(change.newDoc);
			if (
				oldEntry !== null &&
				(newEntry === null ||
					newEntry.shard !== oldEntry.shard ||
					newEntry.key !== oldEntry.key)
			) {
				await this.remove(ctx, { shard: oldEntry.shard, key: oldEntry.key });
			}
			if (newEntry !== null) {
				await this.set(ctx, newEntry);
			}
		};
	}
}

export type { ComponentApi };
