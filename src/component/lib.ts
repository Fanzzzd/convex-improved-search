import { ConvexError, compareValues, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { IndexRange } from "convex/server";
import type { Doc } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { filtersValidator, foldedFieldsValidator } from "./schema.js";
import { CALLS_PER_TRANSACTION, normalizeBudget, normalizeLimit } from "./limits.js";
import {
	MAX_TEXT_LENGTH,
	gramFieldsOf,
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
/**
 * Rows a stream walks toward a seek target before reopening nearer it. On
 * the W1 benchmark 8, 16, 32 and 64 cost 170, 116, 97 and 93 ranges for
 * 1662, 2183, 2786 and 3797 rows; 16 is the last step where the ranges saved
 * outweigh the rows added at the limits' ratio (4096 ranges : 32000 rows).
 */
const LEAP_ROWS = 16;
/**
 * The same, for the candidate stream's one seek per call to the cursor. An
 * exact seek inside a tie group costs a second range once the group drains,
 * so the resume walks further first: on 40 Entries sharing one sortKey and
 * pages of 7, 16 rows cost 4 more ranges than 0.4.0 over the drain.
 */
const RESUME_ROWS = 64;
/** The same, for the docs stream: doc rows are larger, so it reopens sooner. */
const DOC_LEAP_ROWS = 8;
const MIN_STREAM_ROWS = 64;
const MAX_STREAM_ROWS = 4096;
/** Transaction headroom every call leaves for the caller (hydration, its own reads). */
const RESERVED_RANGES = 512;
const RESERVED_ROWS = 4096;
const RESERVED_BYTES = 2 * 1024 * 1024;
/** Entries mid-retag a namespace may hold before search stops trusting any tag. */
const MAX_RETAGGING = 64;
/**
 * The largest docs row the bytesRead headroom plans for: MAX_TEXT_LENGTH
 * codepoints of UTF-8 plus field names and filters. 768 such reads are
 * 12.6 MiB of Convex's 16 MiB per transaction.
 */
const MAX_DOC_BYTES = 4 * MAX_TEXT_LENGTH + 1024;

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
	/** Distinct candidates examined this call, most of them rejected by their postings alone. */
	scanned: v.number(),
	/** Candidates checked against their doc (≤ budget); lets callers cap a multi-call fill. */
	verified: v.number(),
});

/** `z: 1` marks s = -0, which JSON drops but index order keeps below 0. */
type Cursor = { s: number; k: string };
type Posting = Doc<"postings">;
type Position = { sortKey: number; key: string };

function encodeCursor(cursor: Cursor): string {
	return JSON.stringify(Object.is(cursor.s, -0) ? { ...cursor, z: 1 } : cursor);
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
		const negativeZero = (parsed as { z?: unknown }).z === 1 && parsed.s === 0;
		return { s: negativeZero ? -0 : parsed.s, k: parsed.k };
	} catch {
		throw new ConvexError("Invalid search cursor");
	}
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
 * getTransactionMetrics (older backends) a call takes its planned share.
 */
async function transactionHeadroom(
	ctx: QueryCtx,
): Promise<{ ranges: number; rows: number; docs: number }> {
	try {
		const metrics = await ctx.meta.getTransactionMetrics();
		return {
			ranges: metrics.databaseQueries.remaining - RESERVED_RANGES,
			rows: metrics.documentsRead.remaining - RESERVED_ROWS,
			docs: Math.floor((metrics.bytesRead.remaining - RESERVED_BYTES) / MAX_DOC_BYTES),
		};
	} catch {
		// No metrics: assume a fresh transaction shared by CALLS_PER_TRANSACTION calls.
		return {
			ranges: Math.floor((4096 - RESERVED_RANGES) / CALLS_PER_TRANSACTION),
			rows: Math.floor((32000 - RESERVED_ROWS) / CALLS_PER_TRANSACTION),
			docs: Math.floor((16 * 1024 * 1024 - RESERVED_BYTES) / MAX_DOC_BYTES / CALLS_PER_TRANSACTION),
		};
	}
}

/** What one call may still spend: streamed rows and index ranges. */
class CallBudget {
	constructor(
		private rows: number,
		private ranges: number,
	) {}
	/** `must` spends even past zero: the first candidate of a call is always decided. */
	takeRow(must = false): boolean {
		this.rows -= 1;
		return must || this.rows >= 0;
	}
	takeRange(must = false): boolean {
		this.ranges -= 1;
		return must || this.ranges >= 0;
	}
}

/**
 * Where a range starts, DESC: rows with sortKey ≤ / < `sortKey`, or rows in
 * `sortKey`'s tie group with key ≤ / < `key`.
 */
type Seek =
	| { op: "lte" | "lt"; sortKey: number }
	| { op: "tieLte" | "tieLt"; sortKey: number; key: string };

/** by_ns_gram and by_ns_g1 after their two equality fields: both end in (sortKey, key). */
interface SortKeyKeyRange extends IndexRange {
	eq(field: "sortKey", value: number): {
		lte(field: "key", value: string): IndexRange;
		lt(field: "key", value: string): IndexRange;
	};
	lte(field: "sortKey", value: number): IndexRange;
	lt(field: "sortKey", value: number): IndexRange;
}

function applySeek(
	q: SortKeyKeyRange,
	seek: Seek | null,
): IndexRange {
	if (seek === null) return q;
	switch (seek.op) {
		case "lte":
			return q.lte("sortKey", seek.sortKey);
		case "lt":
			return q.lt("sortKey", seek.sortKey);
		case "tieLte":
			return q.eq("sortKey", seek.sortKey).lte("key", seek.key);
		case "tieLt":
			return q.eq("sortKey", seek.sortKey).lt("key", seek.key);
	}
}

/** Which postings a stream reads: one gram (by_ns_gram) or one first codepoint (by_ns_g1). */
type StreamOf = { gram: string } | { g1: string };

function postingRange(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	of: StreamOf,
	seek: Seek | null,
) {
	const postings = ctx.db.query("postings");
	const ranged =
		"gram" in of
			? postings.withIndex("by_ns_gram", (q) =>
					applySeek(q.eq("namespace", namespace).eq("gram", of.gram), seek),
				)
			: postings.withIndex("by_ns_g1", (q) =>
					applySeek(q.eq("namespace", namespace).eq("g1", of.g1), seek),
				);
	return ranged.order("desc");
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
 * over the same order. Ties keep query order. One range per gram: rows in
 * the cursor's tie group that the cursor covers still count, which can only
 * misrank a gram (cost), never drop a match.
 */
async function probeGrams(
	ctx: { db: QueryCtx["db"] },
	namespace: string,
	grams: string[],
	cursor: Cursor | null,
): Promise<{ gram: string; rows: number }[]> {
	const seek: Seek | null = cursor === null ? null : { op: "lte", sortKey: cursor.s };
	const probed = await Promise.all(
		spread(grams, MAX_PROBE_GRAMS).map(async (gram) => {
			const rows = await postingRange(ctx, namespace, { gram }, seek).take(PROBE_ROWS);
			return { gram, rows: rows.length, last: rows.at(-1) ?? null };
		}),
	);
	return probed.sort((a, b) => {
		if (a.rows < PROBE_ROWS || b.rows < PROBE_ROWS) return a.rows - b.rows;
		return a.last === null || b.last === null ? 0 : comparePositions(a.last, b.last);
	});
}

/** What a stream spends through: `must` spends past zero and still succeeds. */
type Budget = { takeRow(must?: boolean): boolean; takeRange(must?: boolean): boolean };

type SeekOptions = {
	/** Stop at the target itself (true) or strictly after it. */
	inclusive: boolean;
	/** Overspend the budget rather than fail. */
	must?: boolean;
	/** Rows walked before each reopen. */
	walk?: number;
	/** False: give up after `walk` rows instead of reopening. */
	reopen?: boolean;
};

/**
 * Rows of one index range in DESC (sortKey, key) order, read through the
 * call's budget: one gram's (or one g1's) postings, or a namespace's docs.
 * The candidate stream, every check stream and the docs stream are
 * SortedStreams, so "skip to the cursor", "does candidate P hold this gram"
 * and "read P's doc" are the same move: `seek`.
 *
 * `seek` walks the open range toward the target. After `walk` rows it
 * reopens at the target's sortKey (one range), and after `walk` more, still
 * inside the target's tie group, at the exact (sortKey, key) (one range).
 * So a seek costs at most 2·walk+1 rows and three ranges, plus one range to
 * open what lies below a drained tie group, however far the target is or
 * however many entries share its sortKey. An exact seek reads only the tie
 * group; once that runs dry the stream is "below sortKey" and opens the rest
 * (`lt sortKey`) only when a later seek or `next` needs it. With `reopen`
 * false the seek gives up after `walk` rows instead, leaving the head
 * before the target.
 */
class SortedStream<Row extends Position> {
	private rows: AsyncIterator<Row> | null = null;
	/** Current row; null at the end. Meaningless while `below` is set. */
	private current: Row | null = null;
	/** Set when every row at this sortKey or above is behind the stream and the rest is unopened. */
	private below: number | null = null;
	/** The sortKey the open range is confined to, when it is an exact (tie group) range. */
	private tieGroup: number | null = null;

	constructor(
		private readonly open: (seek: Seek | null) => AsyncIterator<Row>,
		private readonly budget: Budget,
	) {}

	/** The current row, or null at the end. Only valid after a successful seek/next. */
	get head(): Row | null {
		return this.current;
	}

	/** Positions the stream at its first row ≤ target (`inclusive`) or < target. False when the budget ran out. */
	async seek(
		target: Position | null,
		{ inclusive, must = false, walk = LEAP_ROWS, reopen = true }: SeekOptions,
	): Promise<boolean> {
		const beyond = (row: Position) => {
			const order = comparePositions(row, target!);
			return inclusive ? order > 0 : order >= 0;
		};
		let stage: "walk" | "sortKey" | "exact" = "walk";
		if (this.rows === null) {
			stage = "sortKey";
			const seek: Seek | null = target === null ? null : { op: "lte", sortKey: target.sortKey };
			if (!(await this.reopen(seek, must))) return false;
		}
		if (target === null) return true;
		let walked = 0;
		while (true) {
			if (this.below !== null) {
				// The virtual head sits at (below, lowest key).
				if (compareValues(this.below, target.sortKey) <= 0) return true;
				if (!(await this.land(must))) return false;
				continue;
			}
			if (this.current === null || !beyond(this.current)) return true;
			if (walked >= walk && stage !== "exact") {
				if (!reopen) return true;
				walked = 0;
				const inTieGroup = compareValues(this.current.sortKey, target.sortKey) === 0;
				if (stage === "walk" && !inTieGroup) {
					stage = "sortKey";
					if (!(await this.reopen({ op: "lte", sortKey: target.sortKey }, must))) return false;
				} else {
					stage = "exact";
					const op = inclusive ? "tieLte" : "tieLt";
					if (!(await this.reopen({ op, sortKey: target.sortKey, key: target.key }, must))) return false;
				}
				continue;
			}
			if (!(await this.advance(must))) return false;
			walked += 1;
		}
	}

	/** Moves past the current row. False when the budget ran out. */
	async next(): Promise<boolean> {
		return (await this.advance(false)) && (await this.land(false));
	}

	/** Makes `head` the real next row after a seek that left the stream below a tie group. */
	async land(must: boolean): Promise<boolean> {
		if (this.below === null) return true;
		return await this.reopen({ op: "lt", sortKey: this.below }, must);
	}

	private async reopen(seek: Seek | null, must: boolean): Promise<boolean> {
		if (!this.budget.takeRange(must)) return false;
		this.rows = this.open(seek);
		this.below = null;
		this.tieGroup = seek?.op === "tieLte" || seek?.op === "tieLt" ? seek.sortKey : null;
		return await this.advance(must);
	}

	private async advance(must: boolean): Promise<boolean> {
		if (!this.budget.takeRow(must)) return false;
		const next = await this.rows!.next();
		this.current = next.done ? null : next.value;
		// A tie range ending is not the end of the postings.
		if (next.done && this.tieGroup !== null) this.below = this.tieGroup;
		return true;
	}
}

/**
 * Whether the candidate deserves a doc read: it holds every check gram the
 * check streams reach within their walk, and (when `retagging` is given)
 * some wanted Field holds all of them, by the postings' `fields` tags. A
 * match lies inside one Field, so every query gram's tag names it. `wanted`
 * null means any Field; an untagged posting allows any. Removes from
 * `checks` every stream that fell behind. Null when the call budget ran out
 * first. With `mustDecide` the budget is overspent instead, so every call
 * gets past its first candidate.
 */
async function nominate(
	posting: Posting,
	checks: SortedStream<Posting>[],
	wanted: Set<string> | null,
	retagging: (() => Promise<Set<string> | null>) | null,
	mustDecide: boolean,
): Promise<boolean | null> {
	let useTags = retagging !== null;
	let allowed = wanted;
	const narrow = async (row: Posting) => {
		if (!useTags || row.fields === undefined) return true;
		allowed = new Set(allowed === null ? row.fields : row.fields.filter((name) => allowed!.has(name)));
		if (allowed.size > 0) return true;
		// Tags reject only Entries the reaper is not retagging.
		const pending = await retagging!();
		if (pending !== null && !pending.has(posting.key)) return false;
		useTags = false;
		return true;
	};
	if (!(await narrow(posting))) return false;
	for (const check of [...checks]) {
		// No reopen: a check stream that cannot walk to P cannot reject it
		// for less than the one range the doc stream spends deciding. It is
		// dropped for the rest of the call, since walking on from behind
		// would spend rows on every later candidate too.
		if (!(await check.seek(posting, { inclusive: true, must: mustDecide, reopen: false }))) return null;
		if (check.head !== null && comparePositions(check.head, posting) > 0) {
			checks.splice(checks.indexOf(check), 1);
			continue;
		}
		if (check.head === null || comparePositions(check.head, posting) !== 0) return false;
		if (!(await narrow(check.head))) return false;
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
		const done = { page: [], cursor: null, isDone: true, scanned: 0, verified: 0 };
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
		let of: StreamOf;
		let checkGrams: string[] = [];
		const grams = codepointCount === 1 ? [] : queryGrams(folded);
		if (codepointCount === 1) {
			of = { g1: folded };
		} else if (grams.length === 1) {
			// One gram (two codepoints, or "aaa"): nothing to rank, stream it.
			of = { gram: grams[0] };
		} else {
			const probed = await probeGrams(ctx, args.namespace, grams, cursor);
			// Every match holds every query gram, so an empty gram ends the search.
			if (probed[0].rows === 0) return done;
			of = { gram: probed[0].gram };
			checkGrams = probed.slice(1, 1 + CHECK_GRAMS).map((p) => p.gram);
		}
		const headroom = await transactionHeadroom(ctx);
		// Ranges left after the candidate stream: check stream opens and
		// leaps, and one doc read per verified candidate.
		const callBudget = new CallBudget(
			Math.max(
				MIN_STREAM_ROWS,
				Math.min(budget * ROWS_PER_CANDIDATE, MAX_STREAM_ROWS, headroom.rows),
			),
			Math.min(budget * (1 + checkGrams.length), headroom.ranges - 1),
		);
		const streamOf = (stream: StreamOf) =>
			new SortedStream<Posting>(
				(seek) => postingRange(ctx, args.namespace, stream, seek)[Symbol.asyncIterator](),
				callBudget,
			);
		const candidates = streamOf(of);
		const checks = checkGrams.map((gram) => streamOf({ gram }));
		// Doc rows are what fill bytesRead, walked and verified alike.
		let docRowsLeft = headroom.docs;
		const docs = new SortedStream<Doc<"docs">>(
			(seek) => {
				const range = ctx.db
					.query("docs")
					.withIndex("by_ns_sort", (q) => applySeek(q.eq("namespace", args.namespace), seek))
					.order("desc");
				return range[Symbol.asyncIterator]();
			},
			{
				takeRow: (must = false) => {
					docRowsLeft -= 1;
					return callBudget.takeRow(must) && (must || docRowsLeft >= 0);
				},
				takeRange: (must = false) => callBudget.takeRange(must),
			},
		);
		// Read once, on the first rejection by tags: one range, and none for
		// calls whose tags reject nothing. Too many retags turns tags off.
		let pendingRetags: Promise<Set<string> | null> | undefined;
		const retagging = async () =>
			await (pendingRetags ??= (async () => {
				callBudget.takeRange(true);
				const rows = await ctx.db
					.query("retagging")
					.withIndex("by_ns_key", (q) => q.eq("namespace", args.namespace))
					.take(MAX_RETAGGING + 1);
				return rows.length > MAX_RETAGGING ? null : new Set(rows.map((row) => row.key));
			})());

		const page: { key: string; sortKey: number; matchedFields: string[] }[] = [];
		let verified = 0;
		let examined = 0;
		let last: Cursor | null = null;
		let exhausted = true;
		// `last` only moves past rows this call handled, so running out of
		// budget anywhere leaves a cursor that never covers an unhandled row.
		let more =
			(await candidates.seek(cursor === null ? null : { sortKey: cursor.s, key: cursor.k }, {
				inclusive: false,
				must: true,
				walk: RESUME_ROWS,
			})) && (await candidates.land(true));
		while (more) {
			const posting = candidates.head;
			if (posting === null) break;
			if (!Number.isFinite(posting.sortKey)) {
				throw new ConvexError(
					`Indexed document "${posting.key}" has a non-finite sortKey; re-set or remove it`,
				);
			}
			// One document can own several adjacent rows at one position in
			// this stream (all its g1 grams; briefly, duplicates while a reap
			// is pending).
			if (last !== null && comparePositions(posting, { sortKey: last.s, key: last.k }) === 0) {
				more = await candidates.next();
				continue;
			}
			// g1 rows tag one gram each, not the query codepoint, so tags apply only to gram streams.
			const nominated = await nominate(
				posting,
				checks,
				fieldNames,
				"gram" in of ? retagging : null,
				last === null,
			);
			if (
				nominated === null ||
				(nominated &&
					!(await docs.seek(posting, { inclusive: true, must: last === null, walk: DOC_LEAP_ROWS })))
			) {
				last = cursorBefore(posting);
				exhausted = false;
				break;
			}
			last = cursorAt(posting);
			examined += 1;
			if (nominated) {
				verified += 1;
				const doc = docs.head !== null && comparePositions(docs.head, posting) === 0 ? docs.head : null;
				const matchedFields = verifyCandidate(doc, wantedFilters, folded, fieldNames);
				if (matchedFields !== null) {
					page.push({ key: posting.key, sortKey: posting.sortKey, matchedFields });
				}
				if (page.length >= limit || verified >= budget) {
					exhausted = false;
					break;
				}
			}
			more = await candidates.next();
		}
		if (!more) exhausted = false;

		return {
			page,
			cursor: exhausted || last === null ? null : encodeCursor(last),
			isDone: exhausted,
			scanned: examined,
			verified,
		};
	},
});

/** The candidate's matched field names when it truly matches, else null. */
function verifyCandidate(
	doc: Doc<"docs"> | null,
	wantedFilters: [string, string | number | boolean | null][],
	foldedQuery: string,
	fieldNames: Set<string> | null,
): string[] | null {
	// Filters, and the exact per-field verification that makes the index a
	// pure candidate filter: correctness never rests on the grams, and
	// matched field names fall out for free. `doc` is the docs row at the
	// candidate's (sortKey, key), or null when none lives there: the Entry
	// is gone, or the posting is stale (its reap is pending) and the live
	// posting at doc.sortKey nominates the Entry instead.
	if (doc === null) return null;
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
			// One posting read tells a pre-0.5.0 entry (untagged postings)
			// apart, so re-running a backfill tags it. An entry with no text
			// has no postings and nothing to tag.
			const postingsCurrent =
				Object.is(existing.sortKey, args.sortKey) &&
				sameFields(existing.fields, foldedFields) &&
				(await isTagged(ctx, args.namespace, args.key, foldedFields));
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
		const newGrams = gramFieldsOf(foldedFields);
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
			if (!newGrams.has(gram)) toDelete.push(postingRow);
		}
		// Every row of a kept gram, duplicates included: a duplicate at the
		// current sortKey with a stale tag would drop a true match.
		for (const postingRow of oldPostings) {
			const tag = newGrams.get(postingRow.gram);
			if (
				tag !== undefined &&
				(!Object.is(postingRow.sortKey, args.sortKey) || !sameTag(postingRow.fields, tag))
			) {
				toPatch.push(postingRow);
			}
		}
		// SortKey patches must land inline (a stale sortKey breaks page order).
		// Tag-only patches past the limit (a Field rename over a large text)
		// go to the reaper, and the `retagging` row makes search ignore this
		// Entry's tags until it is done.
		const sortKeyPatches = toPatch.filter((p) => !Object.is(p.sortKey, args.sortKey));
		if (sortKeyPatches.length > SYNC_PATCH_LIMIT) {
			throw new ConvexError(
				`Changing the sortKey of "${args.key}" would rewrite ${sortKeyPatches.length} ` +
					`postings in one transaction (limit ${SYNC_PATCH_LIMIT}). Use a ` +
					`stable sortKey for very large texts, or remove() and re-set() ` +
					`after its reap completes.`,
			);
		}
		const retag = toPatch.length > SYNC_PATCH_LIMIT;
		const patchNow = retag ? sortKeyPatches : toPatch;
		if (retag) await markRetagging(ctx, args.namespace, args.key);
		for (const postingRow of patchNow) {
			await ctx.db.patch("postings", postingRow._id, {
				sortKey: args.sortKey,
				fields: newGrams.get(postingRow.gram),
			});
		}
		// Deletes are deferrable (stale postings are only false candidates), so
		// spend a small inline budget and hand the rest to the reaper. A dup
		// row (same gram twice, from an earlier deferred remove) also needs it.
		let deleteBudget = Math.min(SYNC_DELETE_BUDGET, SYNC_PATCH_LIMIT - patchNow.length);
		let deferred = retag || oldPostings.length !== oldByGram.size;
		for (const postingRow of toDelete) {
			if (deleteBudget <= 0) {
				deferred = true;
				break;
			}
			await ctx.db.delete("postings", postingRow._id);
			deleteBudget -= 1;
		}
		for (const [gram, tag] of newGrams) {
			if (!oldByGram.has(gram)) {
				await ctx.db.insert("postings", {
					namespace: args.namespace,
					key: args.key,
					gram,
					g1: firstCodepoint(gram),
					sortKey: args.sortKey,
					fields: tag,
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

/** Whether the entry's postings carry Field tags (written by 0.5.0 or later). */
async function isTagged(
	ctx: MutationCtx,
	namespace: string,
	key: string,
	foldedFields: Record<string, string>,
): Promise<boolean> {
	const posting = await ctx.db
		.query("postings")
		.withIndex("by_ns_key", (q) => q.eq("namespace", namespace).eq("key", key))
		.first();
	if (posting === null) return Object.values(foldedFields).every((text) => text === "");
	return posting.fields !== undefined;
}

async function markRetagging(ctx: MutationCtx, namespace: string, key: string) {
	const marked = await ctx.db
		.query("retagging")
		.withIndex("by_ns_key", (q) => q.eq("namespace", namespace).eq("key", key))
		.first();
	if (marked === null) await ctx.db.insert("retagging", { namespace, key });
}

function sameTag(a: string[] | undefined, b: string[]): boolean {
	return a !== undefined && a.length === b.length && a.every((name, i) => name === b[i]);
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
		const validGrams = doc === null ? null : gramFieldsOf(doc.fields);
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
			} else {
				const tag = validGrams.get(posting.gram)!;
				if (!Object.is(posting.sortKey, doc!.sortKey) || !sameTag(posting.fields, tag)) {
					await ctx.db.patch("postings", posting._id, { sortKey: doc!.sortKey, fields: tag });
					ops += 1;
				}
			}
		}
		// The whole walk ran in this transaction, so every tag is current.
		const marks = await ctx.db
			.query("retagging")
			.withIndex("by_ns_key", (q) => q.eq("namespace", args.namespace).eq("key", args.key))
			.collect();
		for (const mark of marks) await ctx.db.delete("retagging", mark._id);
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
		const marks = await ctx.db
			.query("retagging")
			.withIndex("by_ns_key", (q) => q.eq("namespace", args.namespace))
			.take(REAP_BATCH - ops);
		for (const mark of marks) await ctx.db.delete("retagging", mark._id);
		return { cursor: marks.length === REAP_BATCH - ops ? "continue" : null };
	},
});
