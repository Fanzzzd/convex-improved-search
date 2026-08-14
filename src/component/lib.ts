import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { QueryCtx } from "./_generated/server.js";
import { filtersValidator } from "./schema.js";
import {
	MAX_TEXT_LENGTH,
	documentGrams,
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

const searchResultValidator = v.object({
	page: v.array(v.object({ key: v.string(), sortKey: v.number() })),
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
		if (typeof parsed.s !== "number" || typeof parsed.k !== "string") {
			throw new Error("bad shape");
		}
		return parsed;
	} catch {
		throw new ConvexError("Invalid search cursor");
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
		const folded = fold(args.query);
		const codepoints = Array.from(folded);
		if (codepoints.length === 0) {
			return { page: [], cursor: null, isDone: true };
		}
		const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
		const budget = Math.max(
			limit,
			Math.min(args.budget ?? DEFAULT_SCAN_BUDGET, MAX_SCAN_BUDGET),
		);
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

		const page: { key: string; sortKey: number }[] = [];
		let scanned = 0;
		let last: Cursor | null = null;
		let exhausted = true;
		let previous: Cursor | null = null;
		for await (const posting of stream) {
			if (coveredByCursor(cursor, posting.sortKey, posting.key)) continue;
			// The g1 index holds one row per (doc, gram-starting-with-g1);
			// duplicates for a doc share (sortKey, key) and are adjacent.
			if (
				previous !== null &&
				previous.s === posting.sortKey &&
				previous.k === posting.key
			) {
				continue;
			}
			previous = { s: posting.sortKey, k: posting.key };
			last = previous;
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
				page.push({ key: posting.key, sortKey: matches });
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

/** Returns the doc's sortKey when the candidate truly matches, else null. */
async function candidateMatches(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	key: string,
	checkGrams: string[],
	wantedFilters: [string, string | number | boolean | null][],
	foldedQuery: string,
): Promise<number | null> {
	// Cheap rejections first: gram membership point-reads…
	for (const gram of checkGrams) {
		const hit = await ctx.db
			.query("postings")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", namespace).eq("key", key).eq("gram", gram),
			)
			.unique();
		if (hit === null) return null;
	}
	// …then the doc read, filters, and the exact verification that makes the
	// index a pure candidate filter: correctness never rests on the grams.
	const doc = await ctx.db
		.query("docs")
		.withIndex("by_ns_key", (q) => q.eq("namespace", namespace).eq("key", key))
		.unique();
	if (doc === null) return null;
	for (const [field, value] of wantedFilters) {
		if (doc.filters?.[field] !== value) return null;
	}
	if (!doc.foldedText.includes(foldedQuery)) return null;
	return doc.sortKey;
}

export const set = mutation({
	args: {
		namespace: v.string(),
		key: v.string(),
		text: v.string(),
		sortKey: v.number(),
		filters: v.optional(filtersValidator),
		/** What to do when the folded text exceeds MAX_TEXT_LENGTH codepoints. Default: truncate. */
		onOverflow: v.optional(v.union(v.literal("truncate"), v.literal("error"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		let folded = fold(args.text);
		if (Array.from(folded).length > MAX_TEXT_LENGTH) {
			if (args.onOverflow === "error") {
				throw new ConvexError(
					`Text exceeds ${MAX_TEXT_LENGTH} codepoints after folding`,
				);
			}
			folded = truncateCodepoints(folded, MAX_TEXT_LENGTH);
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
			foldedText: folded,
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
		const newGrams = documentGrams(folded);
		const oldPostings = await ctx.db
			.query("postings")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
			.collect();
		const oldByGram = new Map(oldPostings.map((p) => [p.gram, p]));
		for (const [gram, postingRow] of oldByGram) {
			if (!newGrams.has(gram)) {
				await ctx.db.delete("postings", postingRow._id);
			} else if (postingRow.sortKey !== args.sortKey) {
				await ctx.db.patch("postings", postingRow._id, { sortKey: args.sortKey });
			}
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
		return null;
	},
});

export const remove = mutation({
	args: { namespace: v.string(), key: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
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
		for (const posting of postings) await ctx.db.delete("postings", posting._id);
		return null;
	},
});

/** Drift inspection for reconcile recipes: what the index believes about one key. */
export const get = query({
	args: { namespace: v.string(), key: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			foldedText: v.string(),
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
		return { foldedText: doc.foldedText, sortKey: doc.sortKey, filters: doc.filters };
	},
});

/**
 * Delete one batch of a namespace, bounded by the per-transaction write
 * budget (a single max-size doc is ~4k postings). Loop until cursor is null:
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
		const WRITE_BUDGET = 3200;
		let writes = 0;
		let lastKey: string | null = null;
		const docs = ctx.db
			.query("docs")
			.withIndex("by_ns_key", (q) => {
				const base = q.eq("namespace", args.namespace);
				return args.cursor != null ? base.gt("key", args.cursor) : base;
			})
			.order("asc");
		for await (const doc of docs) {
			const postings = await ctx.db
				.query("postings")
				.withIndex("by_ns_key", (q) =>
					q.eq("namespace", args.namespace).eq("key", doc.key),
				)
				.collect();
			for (const posting of postings) await ctx.db.delete("postings", posting._id);
			await ctx.db.delete("docs", doc._id);
			writes += postings.length + 1;
			lastKey = doc.key;
			if (writes >= WRITE_BUDGET) {
				return { cursor: lastKey };
			}
		}
		return { cursor: null };
	},
});
