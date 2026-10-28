import { ConvexError, compareValues, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
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

/**
 * The Scan Budget: how many candidates one `search` call may verify. A
 * candidate reaches Verification only after it holds every check gram, and
 * Verification costs one index range (the doc read). Convex allows 4096
 * index ranges per transaction, shared with the caller and with every other
 * `search` call in it, so each call also caps itself at what the transaction
 * has left (see transactionHeadroom). When the budget runs out before the
 * page fills, the returned cursor covers only what was examined — callers
 * keep paging and matches keep arriving; nothing is silently skipped.
 */
const DEFAULT_SCAN_BUDGET = 256;
const MAX_SCAN_BUDGET = 768;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Gram selection. A probe reads the first PROBE_ROWS postings of one query
 * gram after the cursor. The sparsest gram becomes the candidate stream and
 * the next CHECK_GRAMS sparsest are merge-joined against it. Queries with
 * more distinct grams than MAX_PROBE_GRAMS probe an evenly spaced subset.
 */
const MAX_PROBE_GRAMS = 16;
const PROBE_ROWS = 32;
const CHECK_GRAMS = 3;

/**
 * Rows one call may stream after probing (candidate and check streams, doc
 * reads included): ROWS_PER_CANDIDATE per budgeted candidate, between
 * MIN_STREAM_ROWS and MAX_STREAM_ROWS. Convex allows 32000 rows read per
 * transaction.
 */
const ROWS_PER_CANDIDATE = 16;
/** Rows a check stream walks toward a candidate before reopening at it (one range ≈ 8 rows of the per-transaction limits). */
const LEAP_ROWS = 8;
const MIN_STREAM_ROWS = 64;
const MAX_STREAM_ROWS = 4096;
/** Transaction headroom every call leaves for the caller (hydration, its own reads). */
const RESERVED_RANGES = 512;
const RESERVED_ROWS = 4096;

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
	/** Candidates verified this call (≤ budget); lets callers cap a multi-call fill. */
	scanned: v.number(),
});

type Cursor = { s: number; k: string };
type Posting = Doc<"postings">;
type Position = { sortKey: number; key: string };

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

/** Index order of (sortKey, key): Convex's own comparison, UTF-8 order for strings. */
function comparePositions(a: Position, b: Position): number {
	return compareValues(a.sortKey, b.sortKey) || compareValues(a.key, b.key);
}

/** DESC-order "strictly after the cursor": rows the previous page already covered. */
function coveredByCursor(cursor: Cursor | null, position: Position): boolean {
	if (cursor === null) return false;
	return comparePositions(position, { sortKey: cursor.s, key: cursor.k }) >= 0;
}

function cursorAt(position: Position): Cursor {
	return { s: position.sortKey, k: position.key };
}

/** Covers every position before `position` in the DESC stream, but not `position` itself. */
function cursorBefore(position: Position): Cursor {
	// key + "\u0000" is the least key greater than key.
	return { s: position.sortKey, k: position.key + "\u0000" };
}

/**
 * What the rest of the transaction can still afford. Convex counts the
 * caller's reads and every earlier `search` in the same transaction toward
 * one 4096-range / 32000-row limit, so a fixed per-call budget lets a
 * caller that loops over `search` overrun it. Without
 * getTransactionMetrics (older backends) only the static caps apply.
 */
async function transactionHeadroom(
	ctx: QueryCtx,
): Promise<{ ranges: number; rows: number }> {
	try {
		const metrics = await ctx.meta.getTransactionMetrics();
		return {
			ranges: metrics.databaseQueries.remaining - RESERVED_RANGES,
			rows: metrics.documentsRead.remaining - RESERVED_ROWS,
		};
	} catch {
		return { ranges: Infinity, rows: Infinity };
	}
}

function gramStream(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	gram: string,
	sortKeyAtMost: number | null,
) {
	return ctx.db
		.query("postings")
		.withIndex("by_ns_gram", (q) => {
			const base = q.eq("namespace", namespace).eq("gram", gram);
			return sortKeyAtMost === null ? base : base.lte("sortKey", sortKeyAtMost);
		})
		.order("desc");
}

/** At most `max` items, evenly spaced, first and last included. */
function spread<T>(items: T[], max: number): T[] {
	if (items.length <= max) return items;
	return Array.from(
		{ length: max },
		(_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))],
	);
}

/**
 * Probe the query's grams after the cursor, sparsest first. A probe that
 * comes back short is an exact count and sparser than any full one. Of two
 * full probes, the one whose last row lies further back is spread thinner
 * over the same order. Ties keep query order.
 */
async function probeGrams(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	grams: string[],
	cursor: Cursor | null,
): Promise<{ gram: string; rows: number }[]> {
	const probed = await Promise.all(
		spread(grams, MAX_PROBE_GRAMS).map(async (gram) => {
			const rows = await gramStream(ctx, namespace, gram, cursor?.s ?? null).take(PROBE_ROWS);
			return { gram, rows: rows.length, last: rows.at(-1) ?? null };
		}),
	);
	return probed.sort((a, b) => {
		if (a.rows < PROBE_ROWS || b.rows < PROBE_ROWS) return a.rows - b.rows;
		return a.last === null || b.last === null ? 0 : comparePositions(a.last, b.last);
	});
}

/** What one call may still spend: streamed rows and index ranges. */
class CallBudget {
	constructor(
		private rows: number,
		private ranges: number,
	) {}
	takeRow(): boolean {
		if (this.rows <= 0) return false;
		this.rows -= 1;
		return true;
	}
	takeRange(): boolean {
		if (this.ranges <= 0) return false;
		this.ranges -= 1;
		return true;
	}
}

/**
 * One check gram's postings, walked in step with the candidate stream. Both
 * run DESC in the same (sortKey, key) order, so "does candidate P hold this
 * gram" is answered by advancing to P: a few streamed rows instead of one
 * index range per candidate. When P is more than LEAP_ROWS rows away (the
 * probe underrated this gram, or P is far down), the stream reopens at P's
 * sortKey for one range instead. Every live posting of an Entry carries its
 * current sortKey (set rewrites sortKeys inline), so matching P's exact
 * position never misses a true match.
 */
class CheckStream {
	private rows: AsyncIterator<Posting> | null = null;
	private head: Posting | null = null;
	constructor(
		readonly gram: string,
		private readonly open: (sortKeyAtMost: number | null) => AsyncIterator<Posting>,
		private readonly startAt: number | null,
	) {}

	/** Whether P holds the gram; null when the call budget ran out before reaching P. */
	async holds(position: Position, budget: CallBudget): Promise<boolean | null> {
		let walked = 0;
		let leapt = false;
		while (
			this.rows === null ||
			(this.head !== null && comparePositions(this.head, position) > 0)
		) {
			if (this.rows === null || (walked >= LEAP_ROWS && !leapt)) {
				if (!budget.takeRange()) return null;
				const from = this.rows === null ? this.startAt : position.sortKey;
				leapt = this.rows !== null;
				this.rows = this.open(from);
			}
			if (!budget.takeRow()) return null;
			const next = await this.rows.next();
			this.head = next.done ? null : next.value;
			walked += 1;
		}
		return this.head !== null && comparePositions(this.head, position) === 0;
	}
}

/**
 * Whether the candidate holds every check gram; null when the call budget
 * ran out first. With `mustDecide` the rest is answered by point lookups (one
 * index range each), so every call gets past its first candidate.
 */
async function holdsCheckGrams(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	posting: Posting,
	checks: CheckStream[],
	budget: CallBudget,
	mustDecide: boolean,
): Promise<boolean | null> {
	for (const check of checks) {
		let holds = await check.holds(posting, budget);
		if (holds === null) {
			if (!mustDecide) return null;
			// `.first()`, not `.unique()`: a pending reap may leave short-lived duplicate rows.
			holds =
				(await ctx.db
					.query("postings")
					.withIndex("by_ns_key", (q) =>
						q.eq("namespace", namespace).eq("key", posting.key).eq("gram", check.gram),
					)
					.first()) !== null;
		}
		if (!holds) return false;
	}
	return true;
}

export const search = query({
	args: {
		namespace: v.string(),
		query: v.string(),
		filters: v.optional(filtersValidator),
		/** Only these Fields are verified and reported. Default: every Field. */
		fields: v.optional(v.array(v.string())),
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
		budget: v.optional(v.number()),
	},
	returns: searchResultValidator,
	handler: async (ctx, args) => {
		const limit = normalizeLimit(args.limit);
		const budget = normalizeBudget(args.budget, limit);
		assertFiniteFilters(args.filters);
		const done = { page: [], cursor: null, isDone: true, scanned: 0 };
		const fieldNames = args.fields === undefined ? null : new Set(args.fields);
		if (fieldNames !== null && fieldNames.size === 0) return done;
		const folded = fold(args.query);
		// Indexed fields can never exceed this bound, so a longer query is
		// impossible to satisfy. Count only to the bound before allocating an
		// array or the much larger deduplicated bigram set.
		let codepointCount = 0;
		for (const _codepoint of folded) {
			codepointCount += 1;
			if (codepointCount > MAX_TEXT_LENGTH) return done;
		}
		if (codepointCount === 0) return done;
		const cursor = decodeCursor(args.cursor);
		const wantedFilters = Object.entries(args.filters ?? {});

		// Pick the candidate stream. Single codepoint → the g1 index (every
		// document character starts exactly one gram, so g1 coverage is
		// complete). Otherwise stream the sparsest probed gram and merge-join
		// the next sparsest against it, so most false candidates die before
		// the doc read. Any gram's stream is a superset of the true result
		// set, so the probe choice — even a different choice on the next
		// page — never affects correctness, only cost.
		let stream: AsyncIterable<Posting>;
		let checkGrams: string[] = [];
		if (codepointCount === 1) {
			stream = ctx.db
				.query("postings")
				.withIndex("by_ns_g1", (q) => {
					const base = q.eq("namespace", args.namespace).eq("g1", folded);
					return cursor === null ? base : base.lte("sortKey", cursor.s);
				})
				.order("desc");
		} else {
			const probed = await probeGrams(ctx, args.namespace, queryGrams(folded), cursor);
			// Every match holds every query gram, so an empty gram ends the search.
			if (probed[0].rows === 0) return done;
			stream = gramStream(ctx, args.namespace, probed[0].gram, cursor?.s ?? null);
			checkGrams = probed.slice(1, 1 + CHECK_GRAMS).map((p) => p.gram);
		}
		const checks = checkGrams.map(
			(gram) =>
				new CheckStream(
					gram,
					(sortKeyAtMost) =>
						gramStream(ctx, args.namespace, gram, sortKeyAtMost)[Symbol.asyncIterator](),
					cursor?.s ?? null,
				),
		);
		const headroom = await transactionHeadroom(ctx);
		// Ranges left after the candidate stream: check stream opens and
		// leaps, and one doc read per verified candidate.
		const callBudget = new CallBudget(
			Math.max(
				MIN_STREAM_ROWS,
				Math.min(budget * ROWS_PER_CANDIDATE, MAX_STREAM_ROWS, headroom.rows),
			),
			Math.min(budget * (1 + checks.length), headroom.ranges - 1),
		);

		const page: { key: string; sortKey: number; matchedFields: string[] }[] = [];
		let verified = 0;
		let last: Cursor | null = null;
		let exhausted = true;
		for await (const posting of stream) {
			if (!Number.isFinite(posting.sortKey)) {
				throw new ConvexError(
					`Indexed document "${posting.key}" has a non-finite sortKey; re-set or remove it`,
				);
			}
			if (coveredByCursor(cursor, posting)) continue;
			// Checked before `last` moves: the cursor must never cover an unhandled row.
			if (!callBudget.takeRow()) {
				exhausted = false;
				break;
			}
			// One document can own several adjacent rows at one position in
			// this stream (all its g1 grams; briefly, duplicates while a reap
			// is pending).
			if (last !== null && comparePositions(posting, { sortKey: last.s, key: last.k }) === 0) {
				continue;
			}
			const nominated = await holdsCheckGrams(
				ctx,
				args.namespace,
				posting,
				checks,
				callBudget,
				last === null,
			);
			if (nominated === null) {
				last = cursorBefore(posting);
				exhausted = false;
				break;
			}
			if (nominated && !callBudget.takeRange() && last !== null) {
				last = cursorBefore(posting);
				exhausted = false;
				break;
			}
			last = cursorAt(posting);
			if (!nominated) continue;

			verified += 1;
			callBudget.takeRow();
			const matchedFields = await verifyCandidate(
				ctx,
				args.namespace,
				posting,
				wantedFilters,
				folded,
				fieldNames,
			);
			if (matchedFields !== null) {
				page.push({ key: posting.key, sortKey: posting.sortKey, matchedFields });
				if (page.length >= limit) {
					exhausted = false;
					break;
				}
			}
			if (verified >= budget) {
				exhausted = false;
				break;
			}
		}

		return {
			page,
			cursor: exhausted || last === null ? null : encodeCursor(last),
			isDone: exhausted,
			scanned: verified,
		};
	},
});

/** The candidate's matched field names when it truly matches, else null. */
async function verifyCandidate(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	posting: Posting,
	wantedFilters: [string, string | number | boolean | null][],
	foldedQuery: string,
	fieldNames: Set<string> | null,
): Promise<string[] | null> {
	// The doc read, filters, and the exact per-field verification that makes
	// the index a pure candidate filter: correctness never rests on the
	// grams, and matched field names fall out for free.
	const doc = await ctx.db
		.query("docs")
		.withIndex("by_ns_key", (q) => q.eq("namespace", namespace).eq("key", posting.key))
		.unique();
	// A posting whose sortKey disagrees with the doc is stale (its reap is
	// pending); the live posting at doc.sortKey nominates the Entry instead.
	if (doc === null || doc.sortKey !== posting.sortKey) return null;
	for (const [field, value] of wantedFilters) {
		if (doc.filters?.[field] !== value) return null;
	}
	const matchedFields = Object.entries(doc.fields)
		.filter(
			([name, folded]) =>
				(fieldNames === null || fieldNames.has(name)) && folded.includes(foldedQuery),
		)
		.map(([name]) => name);
	return matchedFields.length === 0 ? null : matchedFields;
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
			// Same folded text and sortKey means the postings already match:
			// skip the posting read (up to ~4096 rows) and, when nothing at all
			// changed, the doc write too, so live searches do not rerun. Any
			// leftover duplicates belong to a reap that is already scheduled.
			const postingsCurrent =
				existing.sortKey === args.sortKey &&
				sameFields(existing.fields, foldedFields);
			if (postingsCurrent) {
				if (!sameFilters(existing.filters, args.filters)) {
					await ctx.db.replace("docs", existing._id, docRow);
				}
				return null;
			}
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

function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
	const names = Object.keys(a);
	return (
		names.length === Object.keys(b).length &&
		names.every((name) => Object.hasOwn(b, name) && a[name] === b[name])
	);
}

type Filters = Record<string, string | number | boolean | null>;

function sameFilters(a: Filters | undefined, b: Filters | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	const names = Object.keys(a);
	return (
		names.length === Object.keys(b).length &&
		names.every((name) => Object.hasOwn(b, name) && Object.is(a[name], b[name]))
	);
}

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
