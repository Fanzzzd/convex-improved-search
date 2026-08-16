import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

import { fold } from "../component/grams.js";

export { MAX_TEXT_LENGTH, fold } from "../component/grams.js";

/** Exact-match filter values. `null` is a real value; an absent field matches nothing. */
export type FilterValue = string | number | boolean | null;

/** Mirror the component's defaults (used for client-side bookkeeping only). */
const DEFAULT_LIMIT = 50;
const DEFAULT_SCAN_BUDGET = 256;
const MAX_LIMIT = 200;
const MAX_SCAN_BUDGET = 768;

function normalizeSearchLimit(raw: number | undefined): number {
	if (raw !== undefined && !Number.isFinite(raw)) {
		throw new Error("Search limit must be a finite number");
	}
	return Math.max(1, Math.min(Math.floor(raw ?? DEFAULT_LIMIT), MAX_LIMIT));
}

function normalizeSearchBudget(raw: number | undefined, limit: number): number {
	if (raw !== undefined && !Number.isFinite(raw)) {
		throw new Error("Search budget must be a finite number");
	}
	return Math.max(
		limit,
		Math.min(Math.floor(raw ?? DEFAULT_SCAN_BUDGET), MAX_SCAN_BUDGET),
	);
}

export type SearchHit = {
	key: string;
	sortKey: number;
	/** Names of the entry's fields whose text contains the query (single-text entries: ["text"]). */
	matchedFields: string[];
};

export type SearchResultPage = {
	page: SearchHit[];
	/**
	 * Pass back to keep paging. IMPORTANT: a non-null cursor with a short (or
	 * even empty) page means the scan budget ran out before the page filled —
	 * keep paging and matches keep arriving. Only `isDone: true` means the
	 * search is exhausted.
	 */
	cursor: string | null;
	isDone: boolean;
};

/**
 * Searchable text: one string (indexed under the field name "text"), or
 * named fields. A query never matches across a field boundary, and results
 * report which fields hit via `matchedFields`. Field names follow Convex
 * record-key rules (nonempty ASCII, no leading $/_).
 */
export type SearchText = string | Record<string, string>;

export type IndexEntry<Filter extends string = never> = {
	/** Identifier of the indexed document — typically your doc's `_id`. */
	key: string;
	/** The searchable text. Folded (NFKC + lowercase) and bigram-indexed per field. */
	text: SearchText;
	/** Results are ordered by sortKey descending — typically a creation timestamp. */
	sortKey: number;
	filters?: Partial<Record<Filter, FilterValue>>;
	/** Behavior when the folded fields exceed MAX_TEXT_LENGTH codepoints in total. Default "truncate". */
	onOverflow?: "truncate" | "error";
};

export type SearchArgs<Filter extends string = never> = {
	query: string;
	filters?: Partial<Record<Filter, FilterValue>>;
	cursor?: string | null;
	limit?: number;
	/** Max candidate postings scanned this call. Raise for very selective filters. */
	budget?: number;
};

/** The `paginationOpts` shape Convex clients (e.g. usePaginatedQuery) send. */
export type PaginationOptsLike = { numItems: number; cursor: string | null };

type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type RunMutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
/**
 * Structural — a concrete app ctx is not assignable to
 * `GenericQueryCtx<GenericDataModel>`, so we ask only for what we use.
 * Method syntax on purpose: bivariant params accept any data model.
 */
type MinimalDb = { get(table: string, id: string): Promise<unknown> };
/** A query ctx that can also read the app's tables (for hydration / mapping). */
export type DbQueryCtx = RunQueryCtx & { db: MinimalDb };
/** A mutation ctx that can also read the app's tables (for syncing). */
export type DbMutationCtx = RunQueryCtx & RunMutationCtx & { db: MinimalDb };

/** Wire shape: an ordered field list (Convex records do not preserve key order). */
function wireFields(text: SearchText): { name: string; value: string }[] {
	return typeof text === "string"
		? [{ name: "text", value: text }]
		: Object.entries(text).map(([name, value]) => ({ name, value }));
}

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

async function getDoc<D>(ctx: DbQueryCtx, table: string, key: string): Promise<D | null> {
	return (await ctx.db.get(table, key)) as D | null;
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
 * export const notesSearch = new SearchIndex(components.improvedSearch, {
 *   name: "notes",
 *   filterFields: ["category"],
 * });
 * export const notesIndexer = notesSearch.tableIndexer<Doc<"notes">>({
 *   table: "notes",
 *   map: (ctx, note) =>
 *     note.archived ? null : {
 *       text: { title: note.title, body: note.body },
 *       sortKey: note.createdAt,
 *       filters: { category: note.category },
 *     },
 * });
 *
 * // After any write (insert/edit/archive/delete) — one line, same transaction:
 * await notesIndexer.sync(ctx, noteId);
 *
 * // In your queries (reactive like any Convex query):
 * const { page, isDone, continueCursor } = await notesSearch.searchDocsPaginated<Doc<"notes">>(
 *   ctx,
 *   { table: "notes", query: "停車", paginationOpts },
 * );
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
			fields: wireFields(entry.text),
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
	 * The result set is exactly `docs.filter((d) => someField(d, (f) => fold(f).includes(fold(query))))`
	 * — the inverted index only accelerates, never approximates.
	 */
	async search(ctx: RunQueryCtx, args: SearchArgs<Filter>): Promise<SearchResultPage> {
		return await ctx.runQuery(this.component.lib.search, {
			namespace: this.options.name,
			query: args.query,
			filters: compactFilters(args.filters),
			cursor: args.cursor,
			limit: args.limit,
			budget: args.budget,
		});
	}

	/**
	 * Search + hydrate in one call, for the common case where `key` is a
	 * document `_id` of one table. Keys whose document is gone are dropped
	 * (the page may come up short; the cursor contract is unchanged).
	 */
	async searchDocs<D>(
		ctx: DbQueryCtx,
		args: SearchArgs<Filter> & { table: string },
	): Promise<{
		page: { doc: D; sortKey: number; matchedFields: string[] }[];
		cursor: string | null;
		isDone: boolean;
	}> {
		const result = await this.search(ctx, args);
		const page: { doc: D; sortKey: number; matchedFields: string[] }[] = [];
		for (const hit of result.page) {
			const doc = await getDoc<D>(ctx, args.table, hit.key);
			if (doc !== null) {
				page.push({ doc, sortKey: hit.sortKey, matchedFields: hit.matchedFields });
			}
		}
		return { page, cursor: result.cursor, isDone: result.isDone };
	}

	/**
	 * `search` in Convex's standard paginated shape, so an app query can take
	 * `paginationOpts: paginationOptsValidator` and plug into paginated-query
	 * clients. (Pages are cursor-stable but, unlike `.paginate()`, not
	 * gapless under live updates.)
	 */
	async searchPaginated(
		ctx: RunQueryCtx,
		args: Omit<SearchArgs<Filter>, "cursor" | "limit"> & {
			paginationOpts: PaginationOptsLike;
		},
	): Promise<{ page: SearchHit[]; isDone: boolean; continueCursor: string }> {
		const { paginationOpts, ...rest } = args;
		const result = await this.search(ctx, {
			...rest,
			cursor: paginationOpts.cursor,
			limit: paginationOpts.numItems,
		});
		return {
			page: result.page,
			isDone: result.isDone,
			continueCursor: result.cursor ?? "",
		};
	}

	/** `searchDocs` in Convex's standard paginated shape. */
	async searchDocsPaginated<D>(
		ctx: DbQueryCtx,
		args: Omit<SearchArgs<Filter>, "cursor" | "limit"> & {
			table: string;
			paginationOpts: PaginationOptsLike;
		},
	): Promise<{
		page: { doc: D; sortKey: number; matchedFields: string[] }[];
		isDone: boolean;
		continueCursor: string;
	}> {
		const { paginationOpts, ...rest } = args;
		const result = await this.searchDocs<D>(ctx, {
			...rest,
			cursor: paginationOpts.cursor,
			limit: paginationOpts.numItems,
		});
		return {
			page: result.page,
			isDone: result.isDone,
			continueCursor: result.cursor ?? "",
		};
	}

	/** What the index believes about one key (drift inspection for reconcile recipes). */
	async get(
		ctx: RunQueryCtx,
		args: { key: string },
	): Promise<{
		fields: Record<string, string>;
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
	 * do { ({ cursor } = await notesSearch.clear(ctx, { cursor })); } while (cursor !== null);
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
	 * Bind this index to one table with one mapper, and every sync path comes
	 * for free: `sync(ctx, id)` after any write (works for hard deletes too),
	 * `syncDoc(ctx, doc)` for backfill migrations, and `trigger()` for
	 * `convex-helpers/server/triggers`. Returning `null` keeps the document
	 * out of the index (archived rows, wrong status…).
	 *
	 * Pass your app's ctx type as `Ctx` when the mapper derives text through
	 * app reads (`tableIndexer<Doc<"notes">, MutationCtx>({ … })`) — sync
	 * paths then demand that ctx, and the mapper gets it fully typed.
	 */
	tableIndexer<D extends { _id: string }, Ctx extends DbMutationCtx = DbMutationCtx>(options: {
		table: string;
		/** Index key for a document id. Default: the id itself. */
		key?: (id: string) => string;
		map: (
			ctx: Ctx,
			doc: D,
		) => Omit<IndexEntry<Filter>, "key"> | null | Promise<Omit<IndexEntry<Filter>, "key"> | null>;
	}): TableIndexer<D, Filter, Ctx> {
		return new TableIndexer(this, options);
	}
}

export class TableIndexer<
	D extends { _id: string },
	Filter extends string = never,
	Ctx extends DbMutationCtx = DbMutationCtx,
> {
	constructor(
		private readonly index: SearchIndex<Filter>,
		private readonly options: {
			table: string;
			key?: (id: string) => string;
			map: (
				ctx: Ctx,
				doc: D,
			) =>
				| Omit<IndexEntry<Filter>, "key">
				| null
				| Promise<Omit<IndexEntry<Filter>, "key"> | null>;
		},
	) {}

	private keyOf(id: string): string {
		return this.options.key === undefined ? id : this.options.key(id);
	}

	/**
	 * Bring one document's index entry in line with the table — call once
	 * after any write in the same mutation. A missing document (hard delete)
	 * or a `null` mapping removes the entry; anything else upserts it.
	 */
	async sync(ctx: Ctx, id: string): Promise<void> {
		const doc = await getDoc<D>(ctx, this.options.table, id);
		await this.syncDoc(ctx, doc, id);
	}

	/** `sync` for callers already holding the document — e.g. a migration's `migrateOne`. */
	async syncDoc(ctx: Ctx, doc: D | null, id?: string): Promise<void> {
		const docId = doc?._id ?? id;
		if (docId === undefined) {
			throw new Error("syncDoc needs a document or an explicit id");
		}
		const entry = doc === null ? null : await this.options.map(ctx, doc);
		if (entry === null) {
			await this.index.remove(ctx, { key: this.keyOf(docId) });
			return;
		}
		await this.index.set(ctx, { ...entry, key: this.keyOf(docId) });
	}

	/** Re-sync a batch of documents (e.g. every receipt of one dispatch after replanning). */
	async syncMany(ctx: Ctx, ids: Iterable<string>): Promise<void> {
		for (const id of ids) await this.sync(ctx, id);
	}

	/**
	 * A trigger for `convex-helpers/server/triggers`, driven by the same
	 * mapper: `triggers.register("notes", notesIndexer.trigger())`.
	 */
	trigger(): (ctx: Ctx, change: TriggerChange<D>) => Promise<void> {
		return async (ctx, change) => {
			if (change.operation === "delete") {
				await this.index.remove(ctx, { key: this.keyOf(change.id) });
				return;
			}
			if (change.newDoc !== null) await this.syncDoc(ctx, change.newDoc);
		};
	}
}

/**
 * Locate the folded query inside the original text — the highlight
 * primitive. Folds codepoint by codepoint (same NFKC + lowercase as the
 * index) and maps folded offsets back to original ones, so a half-width
 * query highlights its full-width occurrence. Returns UTF-16 offsets
 * `[start, end)`, or null when no occurrence can be located (a few
 * combining sequences fold differently as a whole string — the match
 * itself is still the index's call, not this function's).
 */
export function findFoldedRange(text: string, query: string): [number, number] | null {
	const foldedQuery = fold(query);
	if (!foldedQuery) return null;
	let folded = "";
	const originOf: number[] = [];
	let origin = 0;
	for (const ch of text) {
		const foldedChar = fold(ch);
		for (let i = 0; i < foldedChar.length; i += 1) originOf.push(origin);
		folded += foldedChar;
		origin += ch.length;
	}
	const at = folded.indexOf(foldedQuery);
	if (at === -1) return null;
	const start = originOf[at];
	const lastOrigin = originOf[at + foldedQuery.length - 1];
	const lastCp = text.codePointAt(lastOrigin);
	return [start, lastOrigin + (lastCp !== undefined && lastCp > 0xffff ? 2 : 1)];
}

/**
 * Split text into segments for highlighting the first match:
 * `matchSegments("ＡＢＣ大樓", "abc")` → `[{text: "ＡＢＣ", match: true}, {text: "大樓", match: false}]`.
 */
export function matchSegments(
	text: string,
	query: string,
): { text: string; match: boolean }[] {
	const range = findFoldedRange(text, query);
	if (range === null) return [{ text, match: false }];
	const segments: { text: string; match: boolean }[] = [];
	if (range[0] > 0) segments.push({ text: text.slice(0, range[0]), match: false });
	segments.push({ text: text.slice(range[0], range[1]), match: true });
	if (range[1] < text.length) segments.push({ text: text.slice(range[1]), match: false });
	return segments;
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
 * // Writes: triggers.register("receipts", receipts.trigger((ctx, doc) => ({
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
		args: SearchArgs<Filter> & {
			/** Live shard list, newest first. May grow between calls; a shard named by an in-flight cursor must still be present. */
			shards: readonly string[];
		},
	): Promise<SearchResultPage> {
		const limit = normalizeSearchLimit(args.limit);
		const budget = normalizeSearchBudget(args.budget, limit);
		let start = 0;
		let inner: string | null = null;
		if (args.cursor != null) {
			let parsed: ShardCursor;
			try {
				parsed = JSON.parse(args.cursor) as ShardCursor;
				if (
					typeof parsed.shard !== "string" ||
					(parsed.inner !== null && typeof parsed.inner !== "string")
				) {
					throw new Error("bad shape");
				}
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
				budget,
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
		map: (
			ctx: DbQueryCtx,
			doc: D,
		) => ShardedIndexEntry<Filter> | null | Promise<ShardedIndexEntry<Filter> | null>,
	): (ctx: DbMutationCtx, change: TriggerChange<D>) => Promise<void> {
		return async (ctx, change) => {
			const oldEntry = change.oldDoc === null ? null : await map(ctx, change.oldDoc);
			const newEntry = change.newDoc === null ? null : await map(ctx, change.newDoc);
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
