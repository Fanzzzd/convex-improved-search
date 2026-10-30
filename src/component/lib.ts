import { ConvexError, compareValues, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { IndexRange } from "convex/server";
import type { Doc } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { filtersValidator, foldedFieldsValidator } from "./schema.js";
import {
	CALLS_PER_TRANSACTION,
	normalizeBudget,
	normalizeLimit,
} from "./limits.js";
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
 * Bytes a seek walks before reopening, beside its row count. Docs rows can
 * reach ~16 KiB (MAX_TEXT_LENGTH codepoints of UTF-8), and one reopen is
 * cheaper than walking several of them past a sparse hit.
 */
const WALK_BYTES = 16 * 1024;
/** Convex's per-transaction limits, for a backend without getTransactionMetrics. */
const TRANSACTION_RANGES = 4096;
const TRANSACTION_ROWS = 32000;
const TRANSACTION_BYTES = 16 * 1024 * 1024;
/**
 * A row read and a byte read, as shares of those limits in range units: the
 * load a call puts on its transaction is ranges + rows·ROW_LOAD + bytes·BYTE_LOAD.
 */
const ROW_LOAD = TRANSACTION_RANGES / TRANSACTION_ROWS;
const BYTE_LOAD = TRANSACTION_RANGES / TRANSACTION_BYTES;
function readLoad(rows: number, bytes: number): number {
	return rows * ROW_LOAD + bytes * BYTE_LOAD;
}

const utf8 = new TextEncoder();
/** A row's size as bytesRead counts it, near enough: its JSON in UTF-8. */
function rowBytes(row: object): number {
	return utf8.encode(JSON.stringify(row)).length;
}

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

/**
 * Position (s, k), plus `g`: the gram plan the call ended with (candidate
 * gram, then Check Grams), so the next call can skip probing, and `d: 1`
 * when it ended walking docs alone. `z: 1` marks s = -0, which JSON drops
 * but index order keeps below 0.
 */
type Cursor = { s: number; k: string; g?: string[]; d?: 1 };
type Posting = Doc<"postings">;
type Position = { sortKey: number; key: string };

function encodeCursor(cursor: Cursor): string {
	return JSON.stringify(Object.is(cursor.s, -0) ? { ...cursor, z: 1 } : cursor);
}

function isPlan(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= 1 + CHECK_GRAMS &&
		value.every((gram) => typeof gram === "string")
	);
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
		const plan = isPlan(parsed.g) ? { g: parsed.g } : {};
		const docsOnly = parsed.d === 1 ? { d: 1 as const } : {};
		return {
			s: negativeZero ? -0 : parsed.s,
			k: parsed.k,
			...plan,
			...docsOnly,
		};
	} catch {
		throw new ConvexError("Invalid search cursor");
	}
}

function assertFiniteFilters(
	filters: Record<string, string | number | boolean | null> | undefined,
) {
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
): Promise<{ ranges: number; rows: number; bytes: number }> {
	try {
		const metrics = await ctx.meta.getTransactionMetrics();
		return {
			ranges: metrics.databaseQueries.remaining - RESERVED_RANGES,
			rows: metrics.documentsRead.remaining - RESERVED_ROWS,
			bytes: metrics.bytesRead.remaining - RESERVED_BYTES,
		};
	} catch {
		// No metrics: assume a fresh transaction shared by CALLS_PER_TRANSACTION calls.
		return {
			ranges: Math.floor(
				(TRANSACTION_RANGES - RESERVED_RANGES) / CALLS_PER_TRANSACTION,
			),
			rows: Math.floor(
				(TRANSACTION_ROWS - RESERVED_ROWS) / CALLS_PER_TRANSACTION,
			),
			bytes: Math.floor(
				(TRANSACTION_BYTES - RESERVED_BYTES) / CALLS_PER_TRANSACTION,
			),
		};
	}
}

/**
 * What one call may still spend: rows, index ranges and bytes, charged in
 * one place for every stream. A row is charged before it is read (so a
 * stream never reads past the cap) and its bytes after, so the bytes cap
 * can overshoot by one row.
 */
class CallBudget {
	constructor(
		private rows: number,
		private ranges: number,
		private bytes: number,
	) {}
	/** `must` spends even past zero: the first candidate of a call is always decided. */
	takeRow(must = false): boolean {
		this.rows -= 1;
		return must || (this.rows >= 0 && this.bytes > 0);
	}
	takeRange(must = false): boolean {
		this.ranges -= 1;
		return must || this.ranges >= 0;
	}
	/** Charges a row just read: its bytes, and the counts every stream adds to. */
	spendRead(bytes: number) {
		this.bytes -= bytes;
		this.rowsRead += 1;
		this.bytesRead += bytes;
	}
	/** Rows and bytes every stream has read. */
	rowsRead = 0;
	bytesRead = 0;
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
	eq(
		field: "sortKey",
		value: number,
	): {
		lte(field: "key", value: string): IndexRange;
		lt(field: "key", value: string): IndexRange;
	};
	lte(field: "sortKey", value: number): IndexRange;
	lt(field: "sortKey", value: number): IndexRange;
}

function applySeek(q: SortKeyKeyRange, seek: Seek | null): IndexRange {
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
	const seek: Seek | null =
		cursor === null ? null : { op: "lte", sortKey: cursor.s };
	const probed = await Promise.all(
		spread(grams, MAX_PROBE_GRAMS).map(async (gram) => {
			const rows = await postingRange(ctx, namespace, { gram }, seek).take(
				PROBE_ROWS,
			);
			return { gram, rows: rows.length, last: rows.at(-1) ?? null };
		}),
	);
	return probed.sort((a, b) => {
		if (a.rows < PROBE_ROWS || b.rows < PROBE_ROWS) return a.rows - b.rows;
		return a.last === null || b.last === null
			? 0
			: comparePositions(a.last, b.last);
	});
}

/** What a stream spends through: `must` spends past zero and still succeeds. */
type Budget = Pick<CallBudget, "takeRow" | "takeRange" | "spendRead">;

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
	private currentBytes = 0;
	/** Ranges this stream has opened, and rows and bytes it has read. */
	opened = 0;
	read = 0;
	bytes = 0;
	/**
	 * Rows reopens jumped over, unread. The target lay past the walk, so each
	 * reopen counts as one more walk: a lower bound, near enough.
	 */
	skipped = 0;
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
			const seek: Seek | null =
				target === null ? null : { op: "lte", sortKey: target.sortKey };
			if (!(await this.reopen(seek, must))) return false;
		}
		if (target === null) return true;
		let walked = 0;
		let walkedBytes = 0;
		while (true) {
			if (this.below !== null) {
				// The virtual head sits at (below, lowest key).
				if (compareValues(this.below, target.sortKey) <= 0) return true;
				if (!(await this.land(must))) return false;
				continue;
			}
			if (this.current === null || !beyond(this.current)) return true;
			if ((walked >= walk || walkedBytes >= WALK_BYTES) && stage !== "exact") {
				if (!reopen) return true;
				this.skipped += walk;
				walked = 0;
				walkedBytes = 0;
				const inTieGroup =
					compareValues(this.current.sortKey, target.sortKey) === 0;
				if (stage === "walk" && !inTieGroup) {
					stage = "sortKey";
					if (
						!(await this.reopen({ op: "lte", sortKey: target.sortKey }, must))
					)
						return false;
				} else {
					stage = "exact";
					const op = inclusive ? "tieLte" : "tieLt";
					if (
						!(await this.reopen(
							{ op, sortKey: target.sortKey, key: target.key },
							must,
						))
					)
						return false;
				}
				continue;
			}
			if (!(await this.advance(must))) return false;
			walked += 1;
			walkedBytes += this.currentBytes;
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
		this.opened += 1;
		this.rows = this.open(seek);
		this.below = null;
		this.tieGroup =
			seek?.op === "tieLte" || seek?.op === "tieLt" ? seek.sortKey : null;
		return await this.advance(must);
	}

	private async advance(must: boolean): Promise<boolean> {
		if (!this.budget.takeRow(must)) return false;
		const next = await this.rows!.next();
		this.read += 1;
		this.current = next.done ? null : next.value;
		this.currentBytes = next.done ? 0 : rowBytes(next.value);
		this.bytes += this.currentBytes;
		this.budget.spendRead(this.currentBytes);
		// A tie range ending is not the end of the postings.
		if (next.done && this.tieGroup !== null) this.below = this.tieGroup;
		return true;
	}
}

/** A Check Gram's stream and how its judgments went this call. */
type Check = {
	gram: string;
	stream: SortedStream<Posting>;
	judged: number;
	/** Candidates it rejected by position (the gram is absent). */
	rejected: number;
	/** Candidates its tags rejected (the gram is in no Field holding the others). */
	narrowed: number;
	/** Wasted ranges to wait for after the stream fell behind, doubling each time. */
	backoff: number;
	/** Sit out candidates until the call has wasted this many ranges. */
	resumeAt: number;
	/** The next seek may reopen (it resumes after falling behind). */
	reopenNext: boolean;
};

/** Wasted ranges a check that fell behind waits for before its first reopen. */
const FIRST_BACKOFF = 4;

/**
 * A check that has judged this many candidates without rejecting one, by
 * position or by tags, is dropped: its rows cost more than the doc reads it
 * saves.
 */
const IDLE_CHECK_JUDGMENTS = 64;
/** Judgments before a check's reject rate says whether the probe ranked it right. */
const MISJUDGED_AFTER = 16;
/** Verified candidates per judgment of whether walking docs alone is cheaper. */
const DENSE_AFTER = 32;
/**
 * Docs passed per judgment of which mode is cheaper, in either mode. At most
 * half the call's budget, so a call that spends its budget in docs mode
 * judges at least once.
 */
const SPARSE_AFTER = 128;
/** Docs a call's last, unfinished window needs before the call judges it. */
const SPARSE_AT_END = 16;

/** A check that rejects most of what it judges is sparser than the candidate gram. */
function isMisjudged(check: Check): boolean {
	return check.judged >= MISJUDGED_AFTER && check.rejected * 2 > check.judged;
}

/**
 * Whether the candidate deserves a doc read: it holds every check gram the
 * check streams reach within their walk, and (when `retagging` is given)
 * some wanted Field holds all of them, by the postings' `fields` tags. A
 * match lies inside one Field, so every query gram's tag names it. `wanted`
 * null means any Field; an untagged posting allows any. `wasted` counts
 * the ranges the docs stream spent reaching candidates their doc then
 * rejected: the evidence a stream that fell behind waits for. Removes from
 * `checks` every stream that rejected nothing, by position or by tags, in
 * IDLE_CHECK_JUDGMENTS judgments. Null when the call budget ran out first.
 * With `mustDecide` the budget is overspent instead, so every call gets
 * past its first candidate.
 */
async function nominate(
	posting: Posting,
	wasted: number,
	checks: Check[],
	wanted: Set<string> | null,
	retagging: (() => Promise<Set<string> | null>) | null,
	mustDecide: boolean,
): Promise<boolean | null> {
	let useTags = retagging !== null;
	let allowed = wanted;
	const narrow = async (row: Posting) => {
		if (!useTags || row.fields === undefined) return true;
		allowed = new Set(
			allowed === null
				? row.fields
				: row.fields.filter((name) => allowed!.has(name)),
		);
		if (allowed.size > 0) return true;
		// Tags reject only Entries the reaper is not retagging.
		const pending = await retagging!();
		if (pending !== null && !pending.has(posting.key)) return false;
		useTags = false;
		return true;
	};
	if (!(await narrow(posting))) return false;
	const drop = (check: Check) => checks.splice(checks.indexOf(check), 1);
	for (const check of [...checks]) {
		// A check stream that cannot walk to P cannot reject it for less than
		// the one range the doc stream spends deciding, and walking on from
		// behind would spend rows on every later candidate too. So it sits
		// out until the docs stream has spent `backoff` more ranges on
		// candidates their doc rejected (doubling each time), then reopens
		// once: a check that is dense here can still be decisive further on,
		// and those wasted ranges say so. Rejections the docs walk reaches
		// for free (clustered candidates) are no evidence.
		if (wasted < check.resumeAt) continue;
		const { stream } = check;
		const reopen = check.reopenNext;
		check.reopenNext = false;
		if (
			!(await stream.seek(posting, {
				inclusive: true,
				must: mustDecide,
				reopen,
			}))
		)
			return null;
		if (stream.head !== null && comparePositions(stream.head, posting) > 0) {
			check.resumeAt = wasted + check.backoff;
			check.backoff *= 2;
			check.reopenNext = true;
			continue;
		}
		check.judged += 1;
		if (stream.head === null || comparePositions(stream.head, posting) !== 0) {
			check.rejected += 1;
			return false;
		}
		if (!(await narrow(stream.head))) {
			check.narrowed += 1;
			return false;
		}
		if (
			check.rejected + check.narrowed === 0 &&
			check.judged >= IDLE_CHECK_JUDGMENTS
		)
			drop(check);
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
		const done = {
			page: [],
			cursor: null,
			isDone: true,
			scanned: 0,
			verified: 0,
		};
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
		} else if (cursor?.d === 1) {
			// Docs mode needs no plan: leaving it plans from the docs it read.
			of = { gram: grams[0] };
		} else if (
			cursor?.g !== undefined &&
			cursor.g.every((gram) => grams.includes(gram))
		) {
			// The previous page's plan, when it judged its checks well (below).
			of = { gram: cursor.g[0] };
			checkGrams = cursor.g.slice(1);
		} else {
			const probed = await probeGrams(ctx, args.namespace, grams, cursor);
			// Every match holds every query gram, so an empty gram ends the search.
			if (probed[0].rows === 0) return done;
			of = { gram: probed[0].gram };
			checkGrams = probed.slice(1, 1 + CHECK_GRAMS).map((p) => p.gram);
		}
		const headroom = await transactionHeadroom(ctx);
		// Every stream of the call (candidates, checks, docs) spends from it.
		const callBudget = new CallBudget(
			Math.max(
				MIN_STREAM_ROWS,
				Math.min(budget * ROWS_PER_CANDIDATE, MAX_STREAM_ROWS, headroom.rows),
			),
			Math.min(
				budget * (1 + Math.min(CHECK_GRAMS, Math.max(0, grams.length - 1))),
				headroom.ranges - 1,
			),
			headroom.bytes,
		);
		const streamOf = (stream: StreamOf) =>
			new SortedStream<Posting>(
				(seek) =>
					postingRange(ctx, args.namespace, stream, seek)[
						Symbol.asyncIterator
					](),
				callBudget,
			);
		let candidates = streamOf(of);
		const checkOf = (gram: string, stream: SortedStream<Posting>): Check => ({
			gram,
			stream,
			judged: 0,
			rejected: 0,
			narrowed: 0,
			backoff: FIRST_BACKOFF,
			resumeAt: 0,
			reopenNext: false,
		});
		const checks = checkGrams.map((gram) => checkOf(gram, streamOf({ gram })));
		const docs = new SortedStream<Doc<"docs">>((seek) => {
			const range = ctx.db
				.query("docs")
				.withIndex("by_ns_sort", (q) =>
					applySeek(q.eq("namespace", args.namespace), seek),
				)
				.order("desc");
			return range[Symbol.asyncIterator]();
		}, callBudget);
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
				return rows.length > MAX_RETAGGING
					? null
					: new Set(rows.map((row) => row.key));
			})());

		const page: { key: string; sortKey: number; matchedFields: string[] }[] =
			[];
		let verified = 0;
		let examined = 0;
		/** Ranges the docs stream spent reaching candidates their doc then rejected. */
		let wasted = 0;
		let last: Cursor | null = null;
		let exhausted = true;
		// Two modes. Postings: stream candidates, merge-join checks, verify the
		// survivors against docs walked in step. Docs: when that reads less,
		// walk the docs alone and verify each one. The docs stream holds
		// every Entry, so docs mode is the oracle itself; only the cost differs.
		let docsOnly = cursor?.d === 1;
		let more = true;
		// Docs mode reads each Entry's text, so it measures what a probe
		// guesses: how many docs hold each gram (in a wanted Field).
		const sampled =
			codepointCount === 1 ? [folded] : spread(grams, MAX_PROBE_GRAMS);
		// Each mode is judged by the rows and bytes it reads per doc passed,
		// in load units; the cheaper one runs. Docs mode reads one doc row.
		const docLoad = () =>
			readLoad(1, docs.read > 0 ? docs.bytes / docs.read : 0);
		// Docs that postings mode walked or jumped over: at least what the
		// docs stream read or skipped, and at least one per candidate.
		const docsPassed = () => Math.max(docs.read + docs.skipped, examined);
		const mark = () => ({
			verified,
			docs: docsPassed(),
			load: readLoad(callBudget.rowsRead, callBudget.bytesRead),
		});
		let since = mark();
		// Per window of docs in docs mode: how many hold each sampled gram,
		// how many hold all of them in one wanted Field (`dense`), and the rows
		// postings mode's docs walk would read to reach those (`walk`: from
		// each, at most DOC_LEAP_ROWS to the next; `gap` docs since the last).
		const span = Math.min(SPARSE_AFTER, Math.ceil(budget / 2));
		const tally = {
			seen: 0,
			dense: 0,
			walk: 0,
			gap: 0,
			held: sampled.map(() => 0),
			last: null as Doc<"docs"> | null,
		};
		const restartTally = () => {
			Object.assign(tally, { seen: 0, dense: 0, walk: 0, gap: 0 });
			tally.held.fill(0);
		};
		const ranked = () =>
			sampled
				.map((gram, i) => ({ gram, held: tally.held[i] }))
				.sort((a, b) => a.held - b.held);
		// A posting's load from the postings the call read, or, before it
		// read any, from the posting row the last doc would have.
		const postingLoad = () => {
			const rows = callBudget.rowsRead - docs.read;
			if (rows > 0)
				return readLoad(1, (callBudget.bytesRead - docs.bytes) / rows);
			const doc = tally.last!;
			return readLoad(
				1,
				rowBytes({
					_id: doc._id,
					_creationTime: doc._creationTime,
					namespace: doc.namespace,
					key: doc.key,
					gram: sampled[0],
					g1: firstCodepoint(sampled[0]),
					sortKey: doc.sortKey,
					fields: Object.keys(doc.fields),
				}),
			);
		};
		// What postings mode would read over the window: the sparsest gram's
		// postings, each check's walk to the next candidate (at most LEAP_ROWS
		// rows per candidate), and the docs walk to the docs the plan verifies,
		// at least the dense ones.
		const postingsCheaper = () => {
			const [first, ...rest] = ranked();
			const postingRows =
				first.held +
				rest
					.slice(0, CHECK_GRAMS)
					.reduce(
						(sum, { held }) => sum + Math.min(held, LEAP_ROWS * first.held),
						0,
					);
			return (
				postingRows * postingLoad() + tally.walk * docLoad() <
				tally.seen * docLoad()
			);
		};
		// Back to postings with a plan from the window: the sparsest gram
		// streams, the next ones check. A gram already streamed keeps its
		// stream (its next seek walks or reopens); none holds an unhandled row
		// above its head, as for a swap.
		const leaveDocs = () => {
			docsOnly = false;
			if ("gram" in of) {
				const open = new Map(checks.map((check) => [check.gram, check.stream]));
				open.set(of.gram, candidates);
				const streamFor = (gram: string) =>
					open.get(gram) ?? streamOf({ gram });
				const [first, ...rest] = ranked();
				of = { gram: first.gram };
				candidates = streamFor(of.gram);
				checks.splice(
					0,
					checks.length,
					...rest
						.slice(0, CHECK_GRAMS)
						.map(({ gram }) => checkOf(gram, streamFor(gram))),
				);
			}
			since = mark();
		};
		const resumeAt = (): Position | null =>
			last !== null
				? { sortKey: last.s, key: last.k }
				: cursor === null
					? null
					: { sortKey: cursor.s, key: cursor.k };
		modes: for (;;) {
			if (docsOnly) {
				more =
					(await docs.seek(resumeAt(), {
						inclusive: false,
						must: last === null,
						walk: RESUME_ROWS,
					})) && (await docs.land(last === null));
				restartTally();
				while (more) {
					const doc = docs.head;
					if (doc === null) break;
					last = cursorAt(doc);
					examined += 1;
					verified += 1;
					tally.seen += 1;
					tally.last = doc;
					sampled.forEach((gram, i) => {
						if (holds(doc, [gram], fieldNames)) tally.held[i] += 1;
					});
					tally.gap += 1;
					if (holds(doc, sampled, fieldNames)) {
						tally.dense += 1;
						tally.walk += Math.min(tally.gap, DOC_LEAP_ROWS);
						tally.gap = 0;
					}
					const matchedFields = verifyCandidate(
						doc,
						wantedFilters,
						folded,
						fieldNames,
					);
					if (matchedFields !== null)
						page.push({ key: doc.key, sortKey: doc.sortKey, matchedFields });
					if (page.length >= limit || verified >= budget) {
						exhausted = false;
						break modes;
					}
					if (tally.seen >= span) {
						if (postingsCheaper()) {
							leaveDocs();
							continue modes;
						}
						restartTally();
					}
					more = await docs.next();
				}
				break modes;
			}
			// `last` only moves past rows this call handled, so running out of
			// budget anywhere leaves a cursor that never covers an unhandled row.
			more =
				(await candidates.seek(resumeAt(), {
					inclusive: false,
					must: last === null,
					walk: RESUME_ROWS,
				})) && (await candidates.land(last === null));
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
				if (
					last !== null &&
					comparePositions(posting, { sortKey: last.s, key: last.k }) === 0
				) {
					more = await candidates.next();
					continue;
				}
				// g1 rows tag one gram each, not the query codepoint, so tags apply only to gram streams.
				const nominated = await nominate(
					posting,
					wasted,
					checks,
					fieldNames,
					"gram" in of ? retagging : null,
					last === null,
				);
				const docRanges = docs.opened;
				if (
					nominated === null ||
					(nominated &&
						!(await docs.seek(posting, {
							inclusive: true,
							must: last === null,
							walk: DOC_LEAP_ROWS,
						})))
				) {
					last = cursorBefore(posting);
					exhausted = false;
					break modes;
				}
				last = cursorAt(posting);
				examined += 1;
				if (nominated) {
					verified += 1;
					const doc =
						docs.head !== null && comparePositions(docs.head, posting) === 0
							? docs.head
							: null;
					const matchedFields = verifyCandidate(
						doc,
						wantedFilters,
						folded,
						fieldNames,
					);
					if (matchedFields !== null) {
						page.push({
							key: posting.key,
							sortKey: posting.sortKey,
							matchedFields,
						});
					} else {
						wasted += docs.opened - docRanges;
					}
					if (page.length >= limit || verified >= budget) {
						exhausted = false;
						break modes;
					}
				}
				// A check that rejects most of what it judges is sparser than the
				// candidate gram here: the probe ranked them wrong (or the corpus
				// changed along the order). It becomes the candidate stream, and the
				// old one a check. Safe once the check has been walked to this
				// candidate: every match holds both grams, and the check stream
				// holds no unhandled row above its head.
				const sparser = checks.find(
					(check) =>
						isMisjudged(check) &&
						(check.stream.head === null ||
							comparePositions(check.stream.head, posting) <= 0),
				);
				if (sparser !== undefined && "gram" in of) {
					checks.splice(
						checks.indexOf(sparser),
						1,
						checkOf(of.gram, candidates),
					);
					for (const check of checks)
						Object.assign(check, { judged: 0, rejected: 0, narrowed: 0 });
					of = { gram: sparser.gram };
					candidates = sparser.stream;
					more = await candidates.land(false);
					continue;
				}
				// When the rows and bytes read since the last judgment come to as
				// much per doc passed as reading those docs alone would, walk the
				// docs alone from here and verify each one. Ranges stay out: a
				// reopen jumps docs the count cannot see. Judged per DENSE_AFTER
				// verifications or `span` docs passed, so a dense stretch counts
				// only while it lasts, and only once every check has shown what
				// it does: it rejected some candidate, or judged enough to be
				// kept or dropped on evidence.
				if (
					checks.every(
						(check) =>
							check.rejected + check.narrowed > 0 ||
							check.judged >= MISJUDGED_AFTER,
					) &&
					(verified - since.verified >= DENSE_AFTER ||
						docsPassed() - since.docs >= span)
				) {
					const now = mark();
					if (now.load - since.load >= (now.docs - since.docs) * docLoad()) {
						docsOnly = true;
						continue modes;
					}
					since = now;
				}
				more = await candidates.next();
			}
			break modes;
		}
		if (!more) exhausted = false;
		// A call that ends inside a window still judges it, given enough docs,
		// so small pages and budgets leave docs mode too.
		if (
			docsOnly &&
			!exhausted &&
			tally.seen >= Math.min(span, SPARSE_AT_END) &&
			postingsCheaper()
		)
			leaveDocs();

		// Carry the plan forward, minus dropped checks, unless a check still
		// rejects most of what it judges (the next page probes again). A call
		// that ended in docs mode tells the next one to start there, and
		// needs no plan.
		const plan = docsOnly
			? { d: 1 as const }
			: "gram" in of && grams.length > 1 && !checks.some(isMisjudged)
				? { g: [of.gram, ...checks.map((check) => check.gram)] }
				: {};
		return {
			page,
			cursor:
				exhausted || last === null ? null : encodeCursor({ ...last, ...plan }),
			isDone: exhausted,
			scanned: examined,
			verified,
		};
	},
});

/** Whether one wanted Field of the doc holds every one of `grams`. */
function holds(
	doc: Doc<"docs">,
	grams: string[],
	fieldNames: Set<string> | null,
): boolean {
	return Object.entries(doc.fields).some(
		([name, text]) =>
			(fieldNames === null || fieldNames.has(name)) &&
			grams.every((gram) => text.includes(gram)),
	);
}

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
				(fieldNames === null || fieldNames.has(name)) &&
				folded.includes(foldedQuery),
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
				if (budget > 0)
					foldedFields[field.name] = truncateCodepoints(folded, budget);
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
				(!Object.is(postingRow.sortKey, args.sortKey) ||
					!sameTag(postingRow.fields, tag))
			) {
				toPatch.push(postingRow);
			}
		}
		// SortKey patches must land inline (a stale sortKey breaks page order).
		// Tag-only patches past the limit (a Field rename over a large text)
		// go to the reaper, and the `retagging` row makes search ignore this
		// Entry's tags until it is done.
		const sortKeyPatches = toPatch.filter(
			(p) => !Object.is(p.sortKey, args.sortKey),
		);
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
		let deleteBudget = Math.min(
			SYNC_DELETE_BUDGET,
			SYNC_PATCH_LIMIT - patchNow.length,
		);
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

function sameFields(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
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
	if (posting === null)
		return Object.values(foldedFields).every((text) => text === "");
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
	return (
		a !== undefined &&
		a.length === b.length &&
		a.every((name, i) => name === b[i])
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
				if (
					!Object.is(posting.sortKey, doc!.sortKey) ||
					!sameTag(posting.fields, tag)
				) {
					await ctx.db.patch("postings", posting._id, {
						sortKey: doc!.sortKey,
						fields: tag,
					});
					ops += 1;
				}
			}
		}
		// The whole walk ran in this transaction, so every tag is current.
		const marks = await ctx.db
			.query("retagging")
			.withIndex("by_ns_key", (q) =>
				q.eq("namespace", args.namespace).eq("key", args.key),
			)
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
 * The greatest namespace below `before` (all of them when absent) that
 * starts with `prefix` and holds an Entry, or null. One index range: how a
 * dated ShardedSearchIndex lists its shards, newest first.
 */
export const namespaceBefore = query({
	args: { prefix: v.string(), before: v.optional(v.string()) },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const doc = await ctx.db
			.query("docs")
			.withIndex("by_ns_sort", (q) =>
				q
					.gte("namespace", args.prefix)
					.lt("namespace", args.before ?? `${args.prefix}\u{10ffff}`),
			)
			.order("desc")
			.first();
		return doc?.namespace ?? null;
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
