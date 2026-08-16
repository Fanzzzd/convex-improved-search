import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { QueryCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { filtersValidator, foldedFieldsValidator } from "./schema.js";
import {
	MAX_TEXT_LENGTH,
	documentGramsOfFields,
	firstCodepoint,
	fold,
	queryGrams,
	truncateCodepoints,
} from "./grams.js";

/**
 * How many candidate postings one `search` call may scan. Every scanned
 * candidate costs up to 4 index ranges (3 membership checks + 1 doc read) and
 * Convex allows 4096 index ranges per transaction, so the ceiling leaves
 * room for the caller's own reads. When the budget runs out before the page
 * fills, the returned cursor points at the last *scanned* row — callers keep
 * paging and matches keep arriving; nothing is silently skipped.
 */
const DEFAULT_SCAN_BUDGET = 256;
const MAX_SCAN_BUDGET = 768;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** How many grams of the query to probe for selectivity, and to verify per candidate. */
const PROBE_GRAMS = 8;
const PROBE_ROWS = 17;
const CHECK_GRAMS = 3;

/**
 * Convex counts every delete/patch as a read toward its 4096-reads-per-
 * transaction limit, so a max-size document (~4096 postings) cannot be
 * unindexed synchronously — and `set`/`remove` share their transaction with
 * the caller. Stale postings are harmless (Verification rejects their
 * documents), so posting deletes beyond a small inline budget are deferred
 * to `reapKey`, a self-rescheduling internal mutation that owns a whole
 * transaction. SortKey rewrites cannot be deferred — a stale sortKey moves a
 * valid posting in the candidate stream and breaks page order — so they run
 * inline and are refused past SYNC_PATCH_LIMIT (in practice: avoid mutable
 * sort keys on multi-thousand-gram texts).
 */
const SYNC_DELETE_BUDGET = 800;
const SYNC_PATCH_LIMIT = 3000;
const REAP_BATCH = 3000;

const searchResultValidator = v.object({
	page: v.array(
		v.object({
			key: v.string(),
			sortKey: v.number(),
			/** Field names whose text contains the query — free with Verification. */
			matchedFields: v.array(v.string()),
		}),
	),
	/** Pass back to continue. Non-null with an unfilled page means "budget spent, keep paging". */
	cursor: v.union(v.string(), v.null()),
	isDone: v.boolean(),
});

type Cursor = { s: number; k: string };

function encodeCursor(cursor: Cursor): string {
	return JSON.stringify(cursor);
}

function decodeCursor(raw: string | null | undefined): Cursor | null {
	if (raw == null) return null;
	try {
		const parsed = JSON.parse(raw) as Cursor;
		if (
			typeof parsed.s !== "number" ||
			!Number.isFinite(parsed.s) ||
			typeof parsed.k !== "string"
		) {
			throw new Error("bad shape");
		}
		return parsed;
	} catch {
		throw new ConvexError("Invalid search cursor");
	}
}

function normalizeLimit(raw: number | undefined): number {
	if (raw !== undefined && !Number.isFinite(raw)) {
		throw new ConvexError("Search limit must be a finite number");
	}
	return Math.max(1, Math.min(Math.floor(raw ?? DEFAULT_LIMIT), MAX_LIMIT));
}

function normalizeBudget(raw: number | undefined, limit: number): number {
	if (raw !== undefined && !Number.isFinite(raw)) {
		throw new ConvexError("Search budget must be a finite number");
	}
	return Math.max(
		limit,
		Math.min(Math.floor(raw ?? DEFAULT_SCAN_BUDGET), MAX_SCAN_BUDGET),
	);
}

function assertFiniteFilters(filters: Record<string, string | number | boolean | null> | undefined) {
	for (const [field, value] of Object.entries(filters ?? {})) {
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new ConvexError(`Filter "${field}" must be a finite number`);
		}
	}
}

/** DESC-order "strictly after the cursor": rows the previous page already covered. */
function coveredByCursor(cursor: Cursor | null, sortKey: number, key: string): boolean {
	if (cursor === null) return false;
	return sortKey > cursor.s || (sortKey === cursor.s && key >= cursor.k);
}

export const search = query({
	args: {
		namespace: v.string(),
		query: v.string(),
		filters: v.optional(filtersValidator),
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
		budget: v.optional(v.number()),
	},
	returns: searchResultValidator,
	handler: async (ctx, args) => {
		const limit = normalizeLimit(args.limit);
		const budget = normalizeBudget(args.budget, limit);
		assertFiniteFilters(args.filters);
		const folded = fold(args.query);
		// Indexed fields can never exceed this bound, so a longer query is
		// impossible to satisfy. Count only to the bound before allocating an
		// array or the much larger deduplicated bigram set.
		let codepointCount = 0;
		for (const _codepoint of folded) {
			codepointCount += 1;
			if (codepointCount > MAX_TEXT_LENGTH) {
				return { page: [], cursor: null, isDone: true };
			}
		}
		if (codepointCount === 0) {
			return { page: [], cursor: null, isDone: true };
		}
		const codepoints = Array.from(folded);
		const cursor = decodeCursor(args.cursor);
		const wantedFilters = Object.entries(args.filters ?? {});

		// Pick the candidate stream. Single codepoint → the g1 index (every
		// document character starts exactly one gram, so g1 coverage is
		// complete). Otherwise probe up to PROBE_GRAMS of the query's grams
		// and stream the scarcest one; a few of the next-scarcest become
		// point-lookup membership checks that reject most false candidates
		// before we pay for the doc read. Any gram's stream is a superset of
		// the true result set, so the probe choice — even a different choice
		// on the next page — never affects correctness, only cost.
		let streamField: "gram" | "g1";
		let streamValue: string;
		let checkGrams: string[] = [];
		if (codepoints.length === 1) {
			streamField = "g1";
			streamValue = folded;
		} else {
			const grams = queryGrams(folded);
			const probed = await Promise.all(
				grams.slice(0, PROBE_GRAMS).map(async (gram) => {
					const rows = await ctx.db
						.query("postings")
						.withIndex("by_ns_gram", (q) =>
							q.eq("namespace", args.namespace).eq("gram", gram),
						)
						.take(PROBE_ROWS);
					return { gram, count: rows.length };
				}),
			);
			probed.sort((a, b) => a.count - b.count);
			streamField = "gram";
			streamValue = probed[0].gram;
			checkGrams = probed.slice(1, 1 + CHECK_GRAMS).map((p) => p.gram);
		}

		const stream =
			streamField === "gram"
				? ctx.db
						.query("postings")
						.withIndex("by_ns_gram", (q) => {
							const base = q.eq("namespace", args.namespace).eq("gram", streamValue);
							return cursor === null ? base : base.lte("sortKey", cursor.s);
						})
						.order("desc")
				: ctx.db
						.query("postings")
						.withIndex("by_ns_g1", (q) => {
							const base = q.eq("namespace", args.namespace).eq("g1", streamValue);
							return cursor === null ? base : base.lte("sortKey", cursor.s);
						})
						.order("desc");

		const page: { key: string; sortKey: number; matchedFields: string[] }[] = [];
		let scanned = 0;
		let streamed = 0;
		let last: Cursor | null = null;
		let exhausted = true;
		const seen = new Set<string>();
		for await (const posting of stream) {
			if (!Number.isFinite(posting.sortKey)) {
				throw new ConvexError(
					`Indexed document "${posting.key}" has a non-finite sortKey; re-set or remove it`,
				);
			}
			if (coveredByCursor(cursor, posting.sortKey, posting.key)) continue;
			// Skipped duplicates cost a streamed row but no reads, so they get
			// their own (generous) cap instead of the scan budget. Checked
			// before `last` moves: the cursor must never cover an unhandled row.
			streamed += 1;
			if (streamed > budget * 8) {
				exhausted = false;
				break;
			}
			last = { s: posting.sortKey, k: posting.key };
			// One document can own many posting rows in this stream (all its
			// g1 grams; briefly, duplicate rows while a reap is pending).
			if (seen.has(posting.key)) continue;
			seen.add(posting.key);
			scanned += 1;

			const matches = await candidateMatches(
				ctx,
				args.namespace,
				posting.key,
				checkGrams,
				wantedFilters,
				folded,
			);
			if (matches !== null) {
				page.push({ key: posting.key, ...matches });
				if (page.length >= limit) {
					exhausted = false;
					break;
				}
			}
			if (scanned >= budget) {
				exhausted = false;
				break;
			}
		}

		return {
			page,
			cursor: exhausted || last === null ? null : encodeCursor(last),
			isDone: exhausted,
		};
	},
});

/** Returns the doc's sortKey + matched field names when the candidate truly matches, else null. */
async function candidateMatches(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	key: string,
	checkGrams: string[],
	wantedFilters: [string, string | number | boolean | null][],
	foldedQuery: string,
): Promise<{ sortKey: number; matchedFields: string[] } | null> {
	// Cheap rejections first: gram membership point-reads. `.first()`, not
	// `.unique()`: a pending reap may leave short-lived duplicate rows.
	for (const gram of checkGrams) {
		const hit = await ctx.db
			.query("postings")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", namespace).eq("key", key).eq("gram", gram),
			)
			.first();
		if (hit === null) return null;
	}
	// …then the doc read, filters, and the exact per-field verification that
	// makes the index a pure candidate filter: correctness never rests on the
	// grams, and matched field names fall out for free.
	const doc = await ctx.db
		.query("docs")
		.withIndex("by_ns_key", (q) => q.eq("namespace", namespace).eq("key", key))
		.unique();
	if (doc === null) return null;
	for (const [field, value] of wantedFilters) {
		if (doc.filters?.[field] !== value) return null;
	}
	const matchedFields = Object.entries(doc.fields)
		.filter(([, folded]) => folded.includes(foldedQuery))
		.map(([name]) => name);
	if (matchedFields.length === 0) return null;
	return { sortKey: doc.sortKey, matchedFields };
}

export const set = mutation({
	args: {
		namespace: v.string(),
		key: v.string(),
		/**
		 * Ordered searchable fields (an array because Convex records do not
		 * preserve key order, and the overflow budget consumes fields in the
		 * order given). Single-text callers send one field named "text".
		 */
		fields: v.array(v.object({ name: v.string(), value: v.string() })),
		sortKey: v.number(),
		filters: v.optional(filtersValidator),
		/** What to do when the folded fields exceed MAX_TEXT_LENGTH codepoints in total. Default: truncate. */
		onOverflow: v.optional(v.union(v.literal("truncate"), v.literal("error"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!Number.isFinite(args.sortKey)) {
			throw new ConvexError("sortKey must be a finite number");
		}
		assertFiniteFilters(args.filters);
		// Fold each field and spend one shared codepoint budget across them in
		// the order given: the overflowing field is cut, later fields dropped.
		const foldedFields: Record<string, string> = {};
		let budget = MAX_TEXT_LENGTH;
		for (const field of args.fields) {
			if (field.name in foldedFields) {
				throw new ConvexError(`Duplicate field name "${field.name}"`);
			}
			const folded = fold(field.value);
			const length = Array.from(folded).length;
			if (length > budget) {
				if (args.onOverflow === "error") {
					throw new ConvexError(
						`Fields exceed ${MAX_TEXT_LENGTH} codepoints after folding`,
					);
				}
				if (budget > 0) foldedFields[field.name] = truncateCodepoints(folded, budget);
				budget = 0;
				continue;
			}
			foldedFields[field.name] = folded;
			budget -= length;
		}

		const existing = await ctx.db
			.query("docs")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
			.unique();
		// replace, not patch: clearing `filters` must drop the field, and
		// patching with undefined is not portable across environments.
		const docRow = {
			namespace: args.namespace,
			key: args.key,
			fields: foldedFields,
			sortKey: args.sortKey,
			...(args.filters === undefined ? {} : { filters: args.filters }),
		};
		if (existing !== null) {
			await ctx.db.replace("docs", existing._id, docRow);
		} else {
			await ctx.db.insert("docs", docRow);
		}

		// Gram diff: text edits touch few grams, so re-setting a document is
		// nearly free; only a full text replacement pays the full fan-out.
		// Grams never span fields: each field gets its own window + sentinel.
		const newGrams = documentGramsOfFields(foldedFields);
		const oldPostings = await ctx.db
			.query("postings")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
			.collect();
		const oldByGram = new Map(oldPostings.map((p) => [p.gram, p]));
		const toPatch: typeof oldPostings = [];
		const toDelete: typeof oldPostings = [];
		for (const [gram, postingRow] of oldByGram) {
			if (!newGrams.has(gram)) {
				toDelete.push(postingRow);
			} else if (postingRow.sortKey !== args.sortKey) {
				toPatch.push(postingRow);
			}
		}
		if (toPatch.length > SYNC_PATCH_LIMIT) {
			throw new ConvexError(
				`Changing the sortKey of "${args.key}" would rewrite ${toPatch.length} ` +
					`postings in one transaction (limit ${SYNC_PATCH_LIMIT}). Use a ` +
					`stable sortKey for very large texts, or remove() and re-set() ` +
					`after its reap completes.`,
			);
		}
		for (const postingRow of toPatch) {
			await ctx.db.patch("postings", postingRow._id, { sortKey: args.sortKey });
		}
		// Deletes are deferrable (stale postings are only false candidates), so
		// spend a small inline budget and hand the rest to the reaper. A dup
		// row (same gram twice, from an earlier deferred remove) also needs it.
		let deleteBudget = Math.min(SYNC_DELETE_BUDGET, SYNC_PATCH_LIMIT - toPatch.length);
		let deferred = oldPostings.length !== oldByGram.size;
		for (const postingRow of toDelete) {
			if (deleteBudget <= 0) {
				deferred = true;
				break;
			}
			await ctx.db.delete("postings", postingRow._id);
			deleteBudget -= 1;
		}
		for (const gram of newGrams) {
			if (!oldByGram.has(gram)) {
				await ctx.db.insert("postings", {
					namespace: args.namespace,
					key: args.key,
					gram,
					g1: firstCodepoint(gram),
					sortKey: args.sortKey,
				});
			}
		}
		if (deferred) {
			await ctx.scheduler.runAfter(0, internal.lib.reapKey, {
				namespace: args.namespace,
				key: args.key,
			});
		}
		return null;
	},
});

export const remove = mutation({
	args: { namespace: v.string(), key: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		// The docs row is the source of truth: once it is gone the Entry can
		// never match again (Verification reads the doc). Leftover postings
		// are cost, not correctness, so only a bounded number die inline.
		const doc = await ctx.db
			.query("docs")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
			.unique();
		if (doc !== null) await ctx.db.delete("docs", doc._id);
		const postings = await ctx.db
			.query("postings")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
			.collect();
		let deleteBudget = SYNC_DELETE_BUDGET;
		let deferred = false;
		for (const posting of postings) {
			if (deleteBudget <= 0) {
				deferred = true;
				break;
			}
			await ctx.db.delete("postings", posting._id);
			deleteBudget -= 1;
		}
		if (deferred) {
			await ctx.scheduler.runAfter(0, internal.lib.reapKey, {
				namespace: args.namespace,
				key: args.key,
			});
		}
		return null;
	},
});

/**
 * Bring one Entry's postings back in line with its docs row: drop postings
 * for grams the (possibly deleted) document no longer contains, drop
 * duplicate rows, and repair stale sortKeys. Owns its whole transaction, so
 * it can afford REAP_BATCH row-ops per run; anything beyond reschedules
 * itself. Idempotent — double-scheduling just wastes one run.
 */
export const reapKey = internalMutation({
	args: { namespace: v.string(), key: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const doc = await ctx.db
			.query("docs")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
			.unique();
		const validGrams = doc === null ? null : documentGramsOfFields(doc.fields);
		let ops = 0;
		let previousGram: string | null = null;
		// by_ns_key orders a key's postings by gram, so duplicates are adjacent.
		const postings = ctx.db
			.query("postings")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			);
		for await (const posting of postings) {
			if (ops >= REAP_BATCH) {
				await ctx.scheduler.runAfter(0, internal.lib.reapKey, args);
				return null;
			}
			const duplicate = posting.gram === previousGram;
			previousGram = posting.gram;
			if (validGrams === null || !validGrams.has(posting.gram) || duplicate) {
				await ctx.db.delete("postings", posting._id);
				ops += 1;
			} else if (doc !== null && posting.sortKey !== doc.sortKey) {
				await ctx.db.patch("postings", posting._id, { sortKey: doc.sortKey });
				ops += 1;
			}
		}
		return null;
	},
});

/** Drift inspection for reconcile recipes: what the index believes about one key. */
export const get = query({
	args: { namespace: v.string(), key: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			fields: foldedFieldsValidator,
			sortKey: v.number(),
			filters: v.optional(filtersValidator),
		}),
	),
	handler: async (ctx, args) => {
		const doc = await ctx.db
			.query("docs")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
			.unique();
		if (doc === null) return null;
		return { fields: doc.fields, sortKey: doc.sortKey, filters: doc.filters };
	},
});

/**
 * Delete one batch of a namespace. Docs die first (so nothing in the
 * namespace can match anymore after the first pass over docs), then
 * postings. The deletes themselves are the progress — each call restarts
 * from the front of what remains, so the returned cursor is only a "not
 * done yet" marker. Loop until cursor is null:
 *
 *   let cursor: string | null = null;
 *   do { ({ cursor } = await clearNamespace(...)); } while (cursor !== null);
 */
export const clearNamespace = mutation({
	args: {
		namespace: v.string(),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.object({ cursor: v.union(v.string(), v.null()) }),
	handler: async (ctx, args) => {
		// Deletes count as reads (4096/transaction); this call owns its
		// transaction, so REAP_BATCH is the right ceiling here too.
		let ops = 0;
		const docs = ctx.db
			.query("docs")
			.withIndex("by_ns_key", (q) => q.eq("namespace", args.namespace));
		for await (const doc of docs) {
			await ctx.db.delete("docs", doc._id);
			ops += 1;
			if (ops >= REAP_BATCH) return { cursor: "continue" };
		}
		const postings = ctx.db
			.query("postings")
			.withIndex("by_ns_key", (q) => q.eq("namespace", args.namespace));
		for await (const posting of postings) {
			await ctx.db.delete("postings", posting._id);
			ops += 1;
			if (ops >= REAP_BATCH) return { cursor: "continue" };
		}
		return { cursor: null };
	},
});
