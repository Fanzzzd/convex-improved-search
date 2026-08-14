import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Exact-match filter values. `null` is a real value (matches docs whose field was set to null). */
export const filterValueValidator = v.union(
	v.string(),
	v.number(),
	v.boolean(),
	v.null(),
);
export const filtersValidator = v.record(v.string(), filterValueValidator);

/**
 * Named searchable Fields, folded. Verification runs per field (a query
 * never matches across a field boundary) and reports which fields hit.
 * Field names follow Convex record-key rules (nonempty ASCII, no leading
 * $/_); single-text entries live under the field name "text".
 */
export const foldedFieldsValidator = v.record(v.string(), v.string());

export default defineSchema({
	/**
	 * One row per indexed document: the folded fields (verification source and
	 * the only text we ever compare against), the caller's sort key, and the
	 * exact-match filter values. `key` is the caller's identifier — typically
	 * their document `_id`, but any string.
	 */
	docs: defineTable({
		namespace: v.string(),
		key: v.string(),
		fields: foldedFieldsValidator,
		sortKey: v.number(),
		filters: v.optional(filtersValidator),
	}).index("by_ns_key", ["namespace", "key"]),

	/**
	 * Inverted index: one row per (document, distinct gram). `g1` is the
	 * gram's first codepoint — the indexable form of single-codepoint queries
	 * (thanks to the end sentinel, every character of a document starts
	 * exactly one gram). `sortKey`/`filters`-independent: postings only order
	 * candidates; truth lives in `docs`.
	 *
	 * - by_ns_gram: candidate stream for one gram, newest first.
	 * - by_ns_g1: candidate stream for single-codepoint queries (may contain
	 *   several rows per doc — deduplicated at query time).
	 * - by_ns_key: all postings of one doc (gram diff on set, delete on remove);
	 *   doubles as the membership check "does doc K contain gram G".
	 */
	postings: defineTable({
		namespace: v.string(),
		gram: v.string(),
		g1: v.string(),
		key: v.string(),
		sortKey: v.number(),
	})
		.index("by_ns_gram", ["namespace", "gram", "sortKey", "key"])
		.index("by_ns_g1", ["namespace", "g1", "sortKey", "key"])
		.index("by_ns_key", ["namespace", "key", "gram"]),
});
