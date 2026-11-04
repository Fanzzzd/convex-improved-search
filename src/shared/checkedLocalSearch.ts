import { ConvexError, compareValues } from "convex/values";
import type { QueryCtx } from "../component/_generated/server.js";
import type { IndexRange } from "convex/server";
import type { Doc } from "../component/_generated/dataModel.js";
import {
	CALLS_PER_TRANSACTION,
	normalizeBudget,
	normalizeLimit,
} from "./limits.js";
import { MAX_TEXT_LENGTH, firstCodepoint, fold, queryGrams } from "./grams.js";

type SearchArgs = {
	namespace: string;
	query: string;
	filters?: Record<string, string | number | boolean | null>;
	fields?: string[];
	cursor?: string | null;
	limit?: number;
	budget?: number;
};
// Keep the checked reader's private initialization off the independent path.
export async function checkedSearch(ctx: QueryCtx, args: SearchArgs) {
	/**
	 * Gram selection. A probe reads the first postings of each query gram after
	 * the cursor (PROBE_FIRST_ROWS, then PROBE_ROWS for the sparsest
	 * PROBE_DEEP). The sparsest gram becomes the candidate stream and
	 * the next CHECK_GRAMS sparsest are merge-joined against it. Queries with
	 * more distinct grams than MAX_PROBE_GRAMS probe an evenly spaced subset.
	 */
	const MAX_PROBE_GRAMS = 16;

	const PROBE_ROWS = 32;

	/** Rows every probed gram reads before the sparsest PROBE_DEEP read on. */
	const PROBE_FIRST_ROWS = 8;

	/**
	 * Grams that read on to PROBE_ROWS: the plan's CHECK_GRAMS + 1 and two
	 * more, since 8 rows misrank a gram whose first rows cluster.
	 */
	const PROBE_DEEP = 6;

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

	/**
	 * The same, for the docs stream. A reopen at the candidate reads its doc
	 * first, so every walked row past the second costs more bytes than the
	 * reopen saves: walks of 8, 4, 2 and 1 cost W1 168968, 144344, 132032 and
	 * 125876 bytes, but 1 reads 5.7% more rows on W21 (block 160).
	 */
	const DOC_LEAP_ROWS = 2;

	const MIN_STREAM_ROWS = 64;

	const MAX_STREAM_ROWS = 4096;

	/** Transaction headroom every call leaves for the caller (hydration, its own reads). */
	const RESERVED_RANGES = 512;

	const RESERVED_ROWS = 4096;

	const CALLER_BYTE_RESERVE = 2 * 1024 * 1024;

	const FALLBACK_BYTE_RESERVE = 2 * 1024 * 1024;

	const RESERVED_BYTES = CALLER_BYTE_RESERVE + FALLBACK_BYTE_RESERVE;

	/**
	 * An optional row can use up to 1 MiB after this check. Leave room for it,
	 * the fallback's one posting plus one doc, and the caller's own reads.
	 * Needs getTransactionMetrics: older backends retain estimate-based caps
	 * under their documented fresh-transaction assumptions.
	 */
	const HARD_RESERVED_BYTES = RESERVED_BYTES + 1024 * 1024;

	/**
	 * The read guard answers from its own count until the estimate comes
	 * within this many bytes of HARD_RESERVED_BYTES (one more max-size row),
	 * or this many rows went by since it last asked the engine.
	 */
	const RECHECK_BYTES = 1024 * 1024;

	const RECHECK_ROWS = 64;

	/** Entries mid-retag a namespace may hold before search stops trusting any tag. */
	const MAX_RETAGGING = 64;

	/**
	 * Bytes a seek walks before reopening, beside its row count. Docs rows can
	 * reach ~16 KiB (MAX_TEXT_LENGTH codepoints of UTF-8), and one reopen is
	 * cheaper than walking several of them past a sparse hit.
	 */
	const WALK_BYTES = 16 * 1024;

	/**
	 * Limit of a docs range in postings mode: the walk and its target. Convex
	 * fetches 100 rows per round trip from persistence when a query sets no
	 * limit, and a limit lowers the fetch to itself. A range that reaches its
	 * limit costs one more range to go on, so only these ranges take one
	 * (large rows, a few read per reopen), and a stream whose range reached it
	 * walks long runs and takes none from then on. Posting rows are small, and
	 * docs mode reads long runs.
	 */
	const DOC_LIMIT = DOC_LEAP_ROWS + 2;

	/** Far candidates whose docs are read by key together. */
	const DOC_BATCH = 8;

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

	/**
	 * Position (s, k), plus `g`: the gram plan the call ended with (candidate
	 * gram, then Check Grams), so the next call can skip probing, and `d: 1`
	 * when it ended walking docs alone. `z: 1` marks s = -0, which JSON drops
	 * but index order keeps below 0.
	 */
	type Cursor = {
		s: number;
		k: string;
		g?: string[];
		/** Per Check Gram of `g`: candidates it judged on earlier pages without rejecting one. */
		j?: number[];
		d?: 1;
	};

	type Posting = Doc<"postings">;

	type Position = { sortKey: number; key: string };

	function encodeCursor(cursor: Cursor): string {
		return JSON.stringify(
			Object.is(cursor.s, -0) ? { ...cursor, z: 1 } : cursor,
		);
	}

	function isPlan(value: unknown): value is string[] {
		return (
			Array.isArray(value) &&
			value.length >= 1 &&
			value.length <= 1 + CHECK_GRAMS &&
			value.every((gram) => typeof gram === "string")
		);
	}

	/** A Cursor before anything was scanned: the page that returns it read nothing. */
	const START_CURSOR = JSON.stringify({ t: 1 });

	function decodeCursor(raw: string | null | undefined): Cursor | null {
		if (raw == null || raw === START_CURSOR) return null;
		try {
			const parsed = JSON.parse(raw) as Cursor;
			if (
				typeof parsed.s !== "number" ||
				!Number.isFinite(parsed.s) ||
				typeof parsed.k !== "string"
			) {
				throw new Error("bad shape");
			}
			const negativeZero =
				(parsed as { z?: unknown }).z === 1 && parsed.s === 0;
			const idle =
				Array.isArray(parsed.j) &&
				isPlan(parsed.g) &&
				parsed.j.length === parsed.g.length - 1 &&
				parsed.j.every((n) => Number.isSafeInteger(n) && n >= 0)
					? { j: parsed.j }
					: {};
			const plan = isPlan(parsed.g) ? { g: parsed.g, ...idle } : {};
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

	function assertFiniteSortKey(posting: Posting) {
		if (!Number.isFinite(posting.sortKey)) {
			throw new ConvexError(
				`Indexed document "${posting.key}" has a non-finite sortKey; re-set or remove it`,
			);
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
	 * The transaction's actual remaining bytes, checked before each optional
	 * row. ctx.meta calls read no rows. Without getTransactionMetrics every
	 * row is allowed and only the estimate-based caps apply.
	 */
	class ReadGuard {
		private noMetrics = false;
		/** Remaining bytes at the last metrics call, and estimates spent since. */
		private known: number | null = null;
		private since = 0;
		private rowsSince = 0;
		constructor(private readonly ctx: QueryCtx) {}
		/** Estimated bytes of a row this call read. */
		spent(bytes: number) {
			this.since += bytes;
			this.rowsSince += 1;
		}
		/**
		 * Each metrics call is a round trip out of the isolate, as costly as a
		 * row. So the guard counts down from the last answer by its own
		 * estimates, and asks again near the reserve (estimates doubled, since
		 * JSON is not the engine's size), or after RECHECK_ROWS rows, which
		 * bounds what reads beside this call can add unseen.
		 */
		async remainingBytes(): Promise<number | null> {
			if (this.noMetrics) return null;
			if (
				this.known !== null &&
				this.rowsSince < RECHECK_ROWS &&
				this.known - 2 * this.since > HARD_RESERVED_BYTES + RECHECK_BYTES
			)
				return this.known - this.since;
			try {
				this.known = (
					await this.ctx.meta.getTransactionMetrics()
				).bytesRead.remaining;
				this.since = 0;
				this.rowsSince = 0;
				return this.known;
			} catch {
				this.noMetrics = true;
				return null;
			}
		}
		/** Whether one more optional row still leaves HARD_RESERVED_BYTES minus that row. */
		async allowsRow(): Promise<boolean> {
			const remaining = await this.remainingBytes();
			return remaining === null || remaining > HARD_RESERVED_BYTES;
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
			private readonly guard: ReadGuard,
		) {}
		/** The actual-bytes guard. `must` never overrides it; the fallback decides instead. */
		async allowsRead(): Promise<boolean> {
			return await this.guard.allowsRow();
		}
		/** `must` spends even past zero: the first candidate of a call is always decided. */
		takeRow(must = false): boolean {
			this.rows -= 1;
			return must || (this.rows >= 0 && this.bytes > 0);
		}
		/** Gives back a row taken for a read that found the end of its range. */
		refundRow() {
			this.rows += 1;
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
			this.guard.spent(bytes);
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
		| {
				op: "lte" | "lt";
				sortKey: number;
				/** Rows below this sortKey stay out of the range (its whole tie group is in). */
				floor?: number;
		  }
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
		gte(
			field: "sortKey",
			value: number,
		): {
			lte(field: "sortKey", value: number): IndexRange;
			lt(field: "sortKey", value: number): IndexRange;
		};
		lte(field: "sortKey", value: number): IndexRange;
		lt(field: "sortKey", value: number): IndexRange;
	}

	function applySeek(q: SortKeyKeyRange, seek: Seek | null): IndexRange {
		if (seek === null) return q;
		switch (seek.op) {
			case "lte":
				return seek.floor === undefined
					? q.lte("sortKey", seek.sortKey)
					: q.gte("sortKey", seek.floor).lte("sortKey", seek.sortKey);
			case "lt":
				return seek.floor === undefined
					? q.lt("sortKey", seek.sortKey)
					: q.gte("sortKey", seek.floor).lt("sortKey", seek.sortKey);
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

	/**
	 * `range` limited to `limit` rows, or whole when the limit is null.
	 * `limit` is the query operator `take` is built on; Convex's public types
	 * leave it out, so a backend without it reads ranges whole.
	 */
	type Limitable<Row> = AsyncIterable<Row> & {
		limit?: (n: number) => AsyncIterable<Row>;
	};
	function limited<Row>(
		range: AsyncIterable<Row>,
		limit: number | null,
	): AsyncIterator<Row> {
		const { limit: withLimit } = range as Limitable<Row>;
		return (
			limit === null || withLimit === undefined
				? range
				: withLimit.call(range, limit)
		)[Symbol.asyncIterator]();
	}
	/** Whether this backend's queries take a limit (see `limited`). */
	function canLimit(ctx: { db: QueryCtx["db"] }): boolean {
		const { limit } = ctx.db
			.query("docs")
			.withIndex("by_ns_sort") as Limitable<unknown>;
		return typeof limit === "function";
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
	 *
	 * Probes share `maxBytes` and read one row at a time, each behind the
	 * actual-bytes guard, so wide postings stop them early. A probe cut short
	 * is not complete: its count is a lower bound, never evidence that the gram
	 * is empty, and a gram with no row read is left out entirely.
	 */
	async function probeGrams(
		ctx: { db: QueryCtx["db"] },
		namespace: string,
		grams: string[],
		cursor: Cursor | null,
		guard: ReadGuard,
		maxBytes: number,
	): Promise<{ gram: string; rows: number; complete: boolean }[]> {
		const seek: Seek | null =
			cursor === null ? null : { op: "lte", sortKey: cursor.s };
		const start = await guard.remainingBytes();
		let estimated = 0;
		const affordable = async () => {
			const remaining = await guard.remainingBytes();
			const spent =
				start === null || remaining === null ? estimated : start - remaining;
			return (
				spent < maxBytes &&
				(remaining === null || remaining > HARD_RESERVED_BYTES)
			);
		};
		type Probe = {
			gram: string;
			rows: number;
			/** Read to `upTo` rows or to the end of its range. */
			complete: boolean;
			/** Read to the end of its range. */
			exhausted: boolean;
			last: Posting | null;
			/** Opened on its first read. */
			iterator: AsyncIterator<Posting> | null;
		};
		/** Reads `probe` on to `upTo` rows; false when the bytes ran out first. */
		const advance = async (probe: Probe, upTo: number) => {
			probe.complete = false;
			probe.iterator ??= limited(
				postingRange(ctx, namespace, { gram: probe.gram }, seek),
				PROBE_ROWS,
			);
			while (probe.rows < upTo) {
				const next = await probe.iterator.next();
				if (next.done) {
					probe.exhausted = true;
					break;
				}
				probe.rows += 1;
				probe.last = next.value;
				const bytes = rowBytes(next.value);
				estimated += bytes;
				guard.spent(bytes);
				if (probe.rows < upTo && !(await affordable())) return false;
			}
			probe.complete = true;
			return true;
		};
		// Sparser first: a gram whose range ended, by its rows; then the
		// one whose last row read lies further back.
		const sparser = (a: Probe, b: Probe) => {
			if (a.exhausted || b.exhausted) {
				if (a.exhausted && b.exhausted) return a.rows - b.rows;
				return a.exhausted ? -1 : 1;
			}
			return a.last === null || b.last === null
				? 0
				: comparePositions(a.last, b.last);
		};
		// Every gram's first PROBE_FIRST_ROWS rank them; only the sparsest
		// PROBE_DEEP read on to PROBE_ROWS and are ranked again. A gram dense
		// near the cursor costs its first rows, not all of them. The grams
		// read side by side: Convex batches reads that are pending together
		// into one round trip, and each probe still stops at the byte cap.
		const all: Probe[] = spread(grams, MAX_PROBE_GRAMS).map((gram) => ({
			gram,
			rows: 0,
			complete: false,
			exhausted: false,
			last: null,
			iterator: null,
		}));
		if (await affordable())
			await Promise.all(all.map((probe) => advance(probe, PROBE_FIRST_ROWS)));
		// A gram with no row read is left out entirely.
		const probed = all.filter((probe) => probe.rows > 0 || probe.complete);
		probed.sort(sparser);
		const deep = probed.slice(0, PROBE_DEEP);
		if (await affordable())
			await Promise.all(
				deep
					.filter((probe) => probe.complete && !probe.exhausted)
					.map((probe) => advance(probe, PROBE_ROWS)),
			);
		deep.sort(sparser);
		for (const probe of all) void probe.iterator?.return?.();
		return [...deep, ...probed.slice(PROBE_DEEP)].map((probe) => ({
			gram: probe.gram,
			rows: probe.rows,
			complete: probe.complete,
		}));
	}

	/** What a stream spends through: `must` spends past zero and still succeeds. */
	type Budget = Pick<
		CallBudget,
		"takeRow" | "refundRow" | "takeRange" | "spendRead" | "allowsRead"
	>;

	type SeekOptions = {
		/** Stop at the target itself (true) or strictly after it. */
		inclusive: boolean;
		/** Overspend the budget rather than fail. */
		must?: boolean;
		/** Rows walked before each reopen. */
		walk?: number;
		/** False: give up after `walk` rows instead of reopening. */
		reopen?: boolean;
		/**
		 * Reopen at once when, by the sortKey spacing of the rows this stream
		 * read in sequence, the target lies more than twice the walk away: each
		 * walked row is a round trip the reopen makes anyway.
		 */
		skipFar?: boolean;
		/**
		 * Asked only when the seek reopens at a far target: a sortKey at or
		 * below the target that no later seek needs rows above, or null. The
		 * reopened range stops there, so the engine reads only what lies
		 * between.
		 */
		floor?: () => Promise<number | null>;
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
		/** Bytes of the last row read1 returned (the lookahead, when there is one). */
		private readBytes = 0;
		/** Ranges this stream has opened, and rows and bytes it has read. */
		opened = 0;
		read = 0;
		bytes = 0;
		/**
		 * Rows reopens jumped over, unread. The target lay past the walk, so each
		 * reopen counts as one more walk: a lower bound, near enough.
		 */
		skipped = 0;
		/**
		 * Ranges opened only to go on below a floored range: the floor is this
		 * call's choice, so they are no evidence of a far target.
		 */
		floorReopens = 0;
		/** Set when every row at this sortKey or above is behind the stream and the rest is unopened. */
		private below: number | null = null;
		/** `below` was set by a floored range ending, not a tie range. */
		private belowFloor = false;
		/** The sortKey the open range is confined to, when it is an exact (tie group) range. */
		private tieGroup: number | null = null;
		/** The lowest sortKey the open range reaches, when it has a floor. */
		private rangeFloor: number | null = null;
		/** The row after `current`, already read and charged. */
		private lookahead: IteratorResult<Row> | null = null;
		/** What the open range was opened with, its limit, and the rows it returned. */
		private rangeSeek: Seek | null = null;
		private rangeLimit: number | null = null;
		private rangeRows = 0;
		private rangeLast: Row | null = null;
		/** Rows of a continued range at or above this one were read before. */
		private skipThrough: Row | null = null;
		/** SortKey steps between rows read in sequence, summed, and their count. */
		private spacing = 0;
		private steps = 0;
		/** A range of this stream reached its limit: it walks long runs, and later ranges take none. */
		private walksRuns = false;
		/** A point read left the stream with no range open. */
		private detached = false;

		constructor(
			private readonly open: (
				seek: Seek | null,
				limit: number | null,
			) => AsyncIterator<Row>,
			private readonly budget: Budget,
			/** The limit of a range opened now; null for none. */
			private readonly limit: () => number | null,
			/** Reads the row at a position by key, for streams that can (docs). */
			private readonly point?: (at: Position) => Promise<Row | null>,
		) {}

		/** The current row, or null at the end. Only valid after a successful seek/next. */
		get head(): Row | null {
			return this.current;
		}

		/** A point read left the stream with nothing open: its targets have been far apart. */
		get isDetached(): boolean {
			return this.detached;
		}

		/** Mean sortKey step between rows read in sequence, or null before two. */
		get step(): number | null {
			return this.steps >= 2 && this.spacing > 0
				? this.spacing / this.steps
				: null;
		}

		/**
		 * Reads the row at each target by key, all at once (one round trip),
		 * and leaves the stream with nothing open, as a point read in `seek`
		 * does. Each entry is the row at that target or null (none there, or
		 * the row moved). Null when the budget cannot pay for all of them.
		 */
		async readAll(targets: Position[]): Promise<(Row | null)[] | null> {
			return await this.readByKey(targets, false, DOC_LEAP_ROWS);
		}

		/** `readAll`, for `seek` too: each key read counts as a reopen that jumped `walk` rows. */
		private async readByKey(
			targets: Position[],
			must: boolean,
			walk: number,
		): Promise<(Row | null)[] | null> {
			const point = this.point;
			if (point === undefined) return null;
			for (const _ of targets)
				if (!this.budget.takeRange(must) || !this.budget.takeRow(must))
					return null;
			if (!(await this.budget.allowsRead())) return null;
			this.close();
			this.detached = true;
			this.lookahead = null;
			this.below = null;
			this.tieGroup = null;
			this.rangeFloor = null;
			this.rangeLimit = null;
			this.rangeLast = null;
			this.current = null;
			this.opened += targets.length;
			this.skipped += targets.length * walk;
			const rows = await Promise.all(targets.map((at) => point(at)));
			return rows.map((row, i) => {
				const bytes = row === null ? 0 : rowBytes(row);
				this.read += 1;
				this.bytes += bytes;
				this.currentBytes = bytes;
				this.budget.spendRead(bytes);
				return row !== null && comparePositions(row, targets[i]!) === 0
					? row
					: null;
			});
		}

		/** Positions the stream at its first row ≤ target (`inclusive`) or < target. False when the budget ran out. */
		async seek(
			target: Position | null,
			{
				inclusive,
				must = false,
				walk = LEAP_ROWS,
				reopen = true,
				floor,
				skipFar = false,
			}: SeekOptions,
		): Promise<boolean> {
			const beyond = (row: Position) => {
				const order = comparePositions(row, target!);
				return inclusive ? order > 0 : order >= 0;
			};
			const bounded = async (sortKey: number) => {
				const at = floor === undefined ? null : await floor();
				return at !== null && compareValues(at, sortKey) <= 0
					? { floor: at }
					: {};
			};
			// A far target whose next posting lies far below it too: no later
			// seek needs a row of the range a reopen would open, so read the
			// target alone by key and leave the stream with nothing open. Null
			// when this seek cannot.
			const pointRead = async (): Promise<boolean | null> => {
				if (this.point === undefined || !skipFar || !inclusive || !target)
					return null;
				const at = floor === undefined ? null : await floor();
				const step = this.step;
				if (
					at !== null &&
					(step === null || target.sortKey - at <= step * walk * 2)
				)
					return null;
				const rows = await this.readByKey([target], must, walk);
				if (rows === null) return false;
				this.current = rows[0]!;
				return true;
			};
			let stage: "walk" | "sortKey" | "exact" = "walk";
			if (this.rows === null) {
				// Only a stream an earlier point read left with nothing open:
				// deciding asks for the floor, a row a first open never read
				// (pages of 1 read 20% more rows).
				if (this.detached) {
					const read = await pointRead();
					if (read !== null) return read;
				}
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
				const step = this.step;
				if (
					skipFar &&
					stage === "walk" &&
					walked === 0 &&
					step !== null &&
					this.current.sortKey - target.sortKey > step * walk * 2
				)
					walked = walk;
				if (
					(walked >= walk || walkedBytes >= WALK_BYTES) &&
					stage !== "exact"
				) {
					if (!reopen) return true;
					this.skipped += walk;
					walked = 0;
					walkedBytes = 0;
					const inTieGroup =
						compareValues(this.current.sortKey, target.sortKey) === 0;
					if (stage === "walk" && !inTieGroup) {
						const read = await pointRead();
						if (read !== null) return read;
						stage = "sortKey";
						if (
							!(await this.reopen(
								{
									op: "lte",
									sortKey: target.sortKey,
									...(await bounded(target.sortKey)),
								},
								must,
							))
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
			if (this.belowFloor) this.floorReopens += 1;
			return await this.reopen({ op: "lt", sortKey: this.below }, must);
		}

		private async reopen(seek: Seek | null, must: boolean): Promise<boolean> {
			if (!this.budget.takeRange(must)) return false;
			this.opened += 1;
			this.detached = false;
			this.rangeSeek = seek;
			this.rangeLimit = this.walksRuns ? null : this.limit();
			this.rangeRows = 0;
			this.rangeLast = null;
			this.skipThrough = null;
			this.close();
			this.rows = this.open(seek, this.rangeLimit);
			this.lookahead = null;
			this.below = null;
			this.tieGroup =
				seek?.op === "tieLte" || seek?.op === "tieLt" ? seek.sortKey : null;
			this.rangeFloor =
				(seek?.op === "lte" || seek?.op === "lt") && seek.floor !== undefined
					? seek.floor
					: null;
			return await this.advance(must);
		}

		/**
		 * The sortKey of the row after the head: read now, charged now, and
		 * the head when the stream moves on. Null at the end of the open
		 * range, or when the budget cannot pay for the row.
		 */
		async peekSortKey(): Promise<number | null> {
			if (this.rows === null || this.below !== null || this.current === null)
				return null;
			if (this.lookahead === null) {
				const read = await this.read1(false);
				if (read === null) return null;
				this.lookahead = read;
			}
			return this.lookahead.done ? null : this.lookahead.value.sortKey;
		}

		/** Reads and charges one row of the open range; null when the budget refuses. */
		private async read1(must: boolean): Promise<IteratorResult<Row> | null> {
			while (true) {
				if (this.rangeLimit !== null && this.rangeRows === this.rangeLimit) {
					if (!(await this.continueRange(must))) return null;
				}
				if (!this.budget.takeRow(must)) return null;
				// Actual bytes, checked even under `must`: a cursor prefix or check
				// stream can hold arbitrarily wide rows.
				if (!(await this.budget.allowsRead())) return null;
				const next = await this.rows!.next();
				// A floored range ending reads no row: its floor is a choice of this
				// call's, so it must not cost a budget the unfloored range would keep.
				if (next.done && this.rangeFloor !== null) {
					this.budget.refundRow();
					return next;
				}
				this.read += 1;
				const bytes = next.done ? 0 : rowBytes(next.value);
				this.readBytes = bytes;
				this.bytes += bytes;
				this.budget.spendRead(bytes);
				if (next.done) return next;
				this.rangeRows += 1;
				// A continued range starts at its predecessor's last sortKey, so
				// it reads that row (and any tied above it) again.
				if (
					this.skipThrough !== null &&
					comparePositions(next.value, this.skipThrough) >= 0
				)
					continue;
				this.skipThrough = null;
				if (this.rangeLast !== null) {
					const step = this.rangeLast.sortKey - next.value.sortKey;
					if (Number.isFinite(step)) {
						this.spacing += step;
						this.steps += 1;
					}
				}
				this.rangeLast = next.value;
				return next;
			}
		}

		/**
		 * The open range stopped at its limit, not its end: open the rest, after
		 * its last row, with no limit. A tie range continues exactly; any other
		 * range from the last row's sortKey, skipping what it already returned.
		 */
		private async continueRange(must: boolean): Promise<boolean> {
			if (!this.budget.takeRange(must)) return false;
			const last = this.rangeLast!;
			const seek = this.rangeSeek;
			if (seek?.op === "tieLte" || seek?.op === "tieLt") {
				this.rangeSeek = { op: "tieLt", sortKey: seek.sortKey, key: last.key };
				this.skipThrough = null;
			} else {
				this.rangeSeek = {
					op: "lte",
					sortKey: last.sortKey,
					...(this.rangeFloor === null ? {} : { floor: this.rangeFloor }),
				};
				this.skipThrough = last;
			}
			this.walksRuns = true;
			this.rangeLimit = null;
			this.rangeRows = 0;
			this.close();
			this.rows = this.open(this.rangeSeek, this.rangeLimit);
			return true;
		}

		/**
		 * Ends the open range's query. A range left unfinished keeps its query,
		 * and the rows Convex fetched ahead for it, until the function ends.
		 */
		close() {
			void this.rows?.return?.();
			this.rows = null;
		}

		private async advance(must: boolean): Promise<boolean> {
			const next = this.lookahead ?? (await this.read1(must));
			this.lookahead = null;
			if (next === null) return false;
			this.current = next.done ? null : next.value;
			this.currentBytes = next.done ? 0 : this.readBytes;
			// A tie range or a floored range ending is not the end of the postings.
			if (next.done) {
				this.below = this.tieGroup ?? this.rangeFloor;
				this.belowFloor = this.tieGroup === null && this.rangeFloor !== null;
			}
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
		/** Candidates it judged on earlier pages of this plan without rejecting one. */
		idle: number;
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
		// A check stream that cannot walk to P cannot reject it for less than
		// the one range the doc stream spends deciding, and walking on from
		// behind would spend rows on every later candidate too. So it sits
		// out until the docs stream has spent `backoff` more ranges on
		// candidates their doc rejected (doubling each time), then reopens
		// once: a check that is dense here can still be decisive further on,
		// and those wasted ranges say so. Rejections the docs walk reaches
		// for free (clustered candidates) are no evidence.
		const active = checks.filter((check) => wasted >= check.resumeAt);
		const seekP = (check: Check) => {
			const reopen = check.reopenNext;
			check.reopenNext = false;
			return check.stream.seek(posting, {
				inclusive: true,
				must: mustDecide,
				reopen,
			});
		};
		// The first and most selective check seeks alone, then the rest side
		// by side, one round trip for all, and all are judged in order. A
		// check that walks toward a candidate an earlier one rejects spends
		// rows it could have skipped by reopening nearer the next one: all
		// three side by side, even only while candidates kept passing, put
		// W19 `07-2607` over 1.05.
		if (active.length > 0) {
			if (!(await seekP(active[0]!))) return null;
			const head = active[0]!.stream.head;
			if (head === null || comparePositions(head, posting) < 0) {
				active[0]!.judged += 1;
				active[0]!.rejected += 1;
				return false;
			}
		}
		const sought = await Promise.all(active.slice(1).map(seekP));
		if (sought.includes(false)) return null;
		// Every check that fell behind sits out, even past an earlier rejection:
		// left in, it would walk again for every candidate.
		const behind = (check: Check) =>
			check.stream.head !== null &&
			comparePositions(check.stream.head, posting) > 0;
		for (const check of active) {
			if (!behind(check)) continue;
			check.resumeAt = wasted + check.backoff;
			check.backoff *= 2;
			check.reopenNext = true;
		}
		for (const check of active) {
			const { stream } = check;
			if (behind(check)) continue;
			check.judged += 1;
			if (
				stream.head === null ||
				comparePositions(stream.head, posting) !== 0
			) {
				check.rejected += 1;
				return false;
			}
			if (!(await narrow(stream.head))) {
				check.narrowed += 1;
				return false;
			}
			if (
				check.rejected + check.narrowed === 0 &&
				check.idle + check.judged >= IDLE_CHECK_JUDGMENTS
			)
				drop(check);
		}
		return true;
	}

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
	let headroom = await transactionHeadroom(ctx);
	// A call always spends a probe and its first candidate, which the
	// reserve covers. Once the caller has read into the reserve, that
	// could overrun the transaction: hand the cursor back unspent.
	const unspent = {
		page: [],
		cursor: args.cursor ?? START_CURSOR,
		isDone: false,
		scanned: 0,
		verified: 0,
	};
	if (headroom.ranges <= 0 || headroom.rows <= 0 || headroom.bytes <= 0) {
		return unspent;
	}
	const guard = new ReadGuard(ctx);

	// Pick the candidate stream. Single codepoint → the g1 index (every
	// document character starts exactly one gram, so g1 coverage is
	// complete). Otherwise stream the sparsest probed gram and merge-join
	// the next sparsest against it, so most false candidates die before
	// the doc read. Any gram's stream is a superset of the true result
	// set, so the probe choice — even a different choice on the next
	// page — never affects correctness, only cost.
	let of: StreamOf;
	let checkGrams: string[] = [];
	/** Idle judgments the plan's checks carry from earlier pages. */
	let carriedIdle: number[] = [];
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
		carriedIdle = cursor.j ?? [];
	} else {
		// Probes may spend half the byte headroom, so the call that follows
		// can still decide a candidate even when every posting is wide.
		const probed = await probeGrams(
			ctx,
			args.namespace,
			grams,
			cursor,
			guard,
			Math.floor(headroom.bytes / 2),
		);
		// Every match holds every query gram, so an empty gram ends the search.
		// Only a probe that read its range to the end proves it empty.
		if (probed.some((p) => p.complete && p.rows === 0)) return done;
		// No gram observed: nothing to plan from, so spend nothing more.
		if (probed.length === 0) return unspent;
		of = { gram: probed[0].gram };
		checkGrams = probed.slice(1, 1 + CHECK_GRAMS).map((p) => p.gram);
		headroom = await transactionHeadroom(ctx);
		// The probes read into the caller's reserve: do not force a first seek.
		if (headroom.ranges <= 0 || headroom.rows <= 0 || headroom.bytes <= 0) {
			return unspent;
		}
	}
	// Every stream of the call (candidates, checks, docs) spends from it.
	const limits = canLimit(ctx);
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
		guard,
	);
	/** Every stream this call opens, closed before it returns. */
	const streams: { close(): void }[] = [];
	const streamOf = (stream: StreamOf) => {
		const opened = new SortedStream<Posting>(
			(seek, limit) =>
				limited(postingRange(ctx, args.namespace, stream, seek), limit),
			callBudget,
			() => null,
		);
		streams.push(opened);
		return opened;
	};
	let candidates = streamOf(of);
	const checkOf = (
		gram: string,
		stream: SortedStream<Posting>,
		idle = 0,
	): Check => ({
		gram,
		stream,
		judged: 0,
		rejected: 0,
		narrowed: 0,
		idle,
		backoff: FIRST_BACKOFF,
		resumeAt: 0,
		reopenNext: false,
	});
	const checks = checkGrams.map((gram, i) =>
		checkOf(gram, streamOf({ gram }), carriedIdle[i] ?? 0),
	);
	const docs = new SortedStream<Doc<"docs">>(
		(seek, limit) =>
			limited(
				ctx.db
					.query("docs")
					.withIndex("by_ns_sort", (q) =>
						applySeek(q.eq("namespace", args.namespace), seek),
					)
					.order("desc"),
				limit,
			),
		callBudget,
		() => (limits && !docsOnly ? DOC_LIMIT : null),
		async (at) =>
			await ctx.db
				.query("docs")
				.withIndex("by_ns_key", (q) =>
					q.eq("namespace", args.namespace).eq("key", at.key),
				)
				.first(),
	);
	streams.push(docs);
	// Read once, on the first rejection by tags: one range, and none for
	// calls whose tags reject nothing. Too many retags turns tags off, and
	// so does a read the byte guard cut short: a partial set could reject
	// a true match.
	let pendingRetags: Promise<Set<string> | null> | undefined;
	const retagging = async () =>
		await (pendingRetags ??= (async () => {
			callBudget.takeRange(true);
			const range = ctx.db
				.query("retagging")
				.withIndex("by_ns_key", (q) => q.eq("namespace", args.namespace));
			const rows = range[Symbol.asyncIterator]();
			const keys = new Set<string>();
			for (let read = 0; read <= MAX_RETAGGING; read++) {
				if (!(await guard.allowsRow())) return null;
				const next = await rows.next();
				if (next.done) return keys;
				guard.spent(rowBytes(next.value));
				keys.add(next.value.key);
			}
			return null;
		})());

	const page: { key: string; sortKey: number; matchedFields: string[] }[] = [];
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
	const docLoad = () => readLoad(1, docs.read > 0 ? docs.bytes / docs.read : 0);
	// Docs that postings mode walked or jumped over: at least what the
	// docs stream read or skipped, and at least one per candidate.
	const docsPassed = () => Math.max(docs.read + docs.skipped, examined);
	const mark = () => ({
		verified,
		docs: docsPassed(),
		load: readLoad(callBudget.rowsRead, callBudget.bytesRead),
	});
	let since = mark();
	// Per window of docs in docs mode: how many hold each sampled gram in
	// any Field (a gram's stream holds them all), how many hold all of
	// them in one Field (`dense`), a wanted one once the call has read a
	// tagged posting (tags reject the rest), and the rows postings mode's
	// docs walk would read to reach those (`walk`: from each, at most
	// DOC_LEAP_ROWS to the next; `gap` docs since the last).
	let tagged = false;
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
			const streamFor = (gram: string) => open.get(gram) ?? streamOf({ gram });
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
					if (holds(doc, [gram], null)) tally.held[i] += 1;
				});
				tally.gap += 1;
				if (holds(doc, sampled, tagged ? fieldNames : null)) {
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
		/** Far candidates may still have their docs read in batches. */
		let batching = true;
		while (more) {
			const posting = candidates.head;
			if (posting === null) break;
			assertFiniteSortKey(posting);
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
			if ("gram" in of && posting.fields !== undefined) tagged = true;
			// Far candidates: each doc is a point read anyway, so the next few
			// candidates are checked in order and the docs of those that pass
			// read together, as patched 0.4.0 did, one round trip for all.
			// Never more than the page or the budget can take, so no doc is
			// read for a candidate the call won't decide. Ends for the call
			// once two candidates lie near. Only while every check left has
			// judged MISJUDGED_AFTER candidates (on this page or carried) and
			// rejected none: a batch skips the swap and docs-mode judgments
			// below, and with checks that reject (or sit out and may) it read
			// docs they would have spared (W1 1.08 of 0.5.0's load).
			const room = Math.min(DOC_BATCH, limit - page.length, budget - verified);
			if (
				batching &&
				last !== null &&
				room >= 2 &&
				docs.isDetached &&
				checks.every(
					(check) =>
						check.rejected + check.narrowed === 0 &&
						check.idle + check.judged >= MISJUDGED_AFTER,
				)
			) {
				const batch: Posting[] = [posting];
				while (batch.length < room) {
					more = await candidates.next();
					const next = more ? candidates.head : null;
					if (next === null) break;
					assertFiniteSortKey(next);
					if (comparePositions(next, batch.at(-1)!) !== 0) batch.push(next);
				}
				const step = docs.step;
				for (let i = 1; i < batch.length; i++)
					if (
						step === null ||
						batch[i - 1]!.sortKey - batch[i]!.sortKey <=
							step * DOC_LEAP_ROWS * 2
					)
						batching = false;
				const tagsFor = "gram" in of ? retagging : null;
				const nominated: boolean[] = [];
				// The candidate the budget stopped at, undecided.
				let undecided: Posting | null = null;
				for (const candidate of batch) {
					const verdict = await nominate(
						candidate,
						wasted,
						checks,
						fieldNames,
						tagsFor,
						false,
					);
					if (verdict === null) {
						undecided = candidate;
						break;
					}
					nominated.push(verdict);
				}
				batch.length = nominated.length;
				const rows = await docs.readAll(batch.filter((_, i) => nominated[i]));
				if (rows === null) {
					last = cursorBefore(posting);
					exhausted = false;
					break modes;
				}
				let read = 0;
				for (const [i, candidate] of batch.entries()) {
					last = cursorAt(candidate);
					examined += 1;
					if (!nominated[i]) continue;
					verified += 1;
					const matchedFields = verifyCandidate(
						rows[read++]!,
						wantedFilters,
						folded,
						fieldNames,
					);
					if (matchedFields !== null)
						page.push({
							key: candidate.key,
							sortKey: candidate.sortKey,
							matchedFields,
						});
					else wasted += 1;
				}
				if (undecided !== null) {
					last = cursorBefore(undecided);
					exhausted = false;
					break modes;
				}
				if (page.length >= limit || verified >= budget) {
					exhausted = false;
					break modes;
				}
				// Past the batch's last posting, unless the range already ended.
				if (more && candidates.head !== null) more = await candidates.next();
				continue;
			}
			const docRanges = docs.opened - docs.floorReopens;
			// The doc waits for the checks: read beside them, every rejection
			// wastes it (W5 and W19 `07-2607` over 1.05).
			const nominated = await nominate(
				posting,
				wasted,
				checks,
				fieldNames,
				// g1 rows tag one gram each, not the query codepoint, so tags apply only to gram streams.
				"gram" in of ? retagging : null,
				last === null,
			);
			// A far docs seek opens a range floored at the next posting, so the
			// engine fetches only the docs between. Check streams keep open
			// ranges (floored, W5 read 1% more).
			if (
				nominated === null ||
				(nominated &&
					!(await docs.seek(posting, {
						inclusive: true,
						must: last === null,
						walk: DOC_LEAP_ROWS,
						floor: () => candidates.peekSortKey(),
						skipFar: true,
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
					wasted += docs.opened - docs.floorReopens - docRanges;
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
				checks.splice(checks.indexOf(sparser), 1, checkOf(of.gram, candidates));
				for (const check of checks)
					Object.assign(check, {
						judged: 0,
						rejected: 0,
						narrowed: 0,
						idle: 0,
					});
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
	// The byte guard stopped the call before it decided one candidate. Decide
	// exactly the next one after the input cursor, ignoring checks: one
	// posting (at most two ranges, one row) and its doc by key (one row), or
	// in docs mode the next doc alone. The hard reserve leaves room for both,
	// and the cursor moves even when the candidate is stale or rejected.
	if (!exhausted && examined === 0) {
		const remaining = await guard.remainingBytes();
		if (remaining !== null && remaining < RESERVED_BYTES) return unspent;
		const after: Position | null =
			cursor === null ? null : { sortKey: cursor.s, key: cursor.k };
		const tieAfter: Seek | null =
			after === null
				? null
				: { op: "tieLt", sortKey: after.sortKey, key: after.key };
		const below: Seek | null =
			after === null ? null : { op: "lt", sortKey: after.sortKey };
		const docAt = (seek: Seek | null) =>
			ctx.db
				.query("docs")
				.withIndex("by_ns_sort", (q) =>
					applySeek(q.eq("namespace", args.namespace), seek),
				)
				.order("desc")
				.first();
		let candidate: Position | null;
		let doc: Doc<"docs"> | null;
		if (docsOnly) {
			doc =
				(await docAt(tieAfter)) ?? (after === null ? null : await docAt(below));
			candidate = doc;
		} else {
			const posting =
				(await postingRange(ctx, args.namespace, of, tieAfter).first()) ??
				(after === null
					? null
					: await postingRange(ctx, args.namespace, of, below).first());
			if (posting !== null) assertFiniteSortKey(posting);
			candidate = posting;
			doc =
				posting === null
					? null
					: await ctx.db
							.query("docs")
							.withIndex("by_ns_key", (q) =>
								q.eq("namespace", args.namespace).eq("key", posting.key),
							)
							.first();
		}
		if (candidate === null) {
			exhausted = true;
		} else {
			examined = 1;
			verified = 1;
			const matchedFields = verifyCandidate(
				doc !== null && comparePositions(doc, candidate) === 0 ? doc : null,
				wantedFilters,
				folded,
				fieldNames,
			);
			if (matchedFields !== null)
				page.push({
					key: candidate.key,
					sortKey: candidate.sortKey,
					matchedFields,
				});
			last = cursorAt(candidate);
		}
	}
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
	// rejects most of what it judges (the next page probes again). A check
	// that rejected nothing carries its judgments across pages where most
	// verified candidates were hits, so on short pages it is dropped as in
	// one long call. Where docs reject most of what the checks pass, the
	// corpus may yet change along the order and give it work, so its count
	// starts again (W20 at budget 2 took a call more). A call that ended in
	// docs mode tells the next one to start there, and needs no plan.
	const hitsMostly = page.length * 2 >= verified;
	const idle = checks.map((check) =>
		hitsMostly && check.rejected + check.narrowed === 0
			? check.idle + check.judged
			: 0,
	);
	const plan = docsOnly
		? { d: 1 as const }
		: "gram" in of && grams.length > 1 && !checks.some(isMisjudged)
			? {
					g: [of.gram, ...checks.map((check) => check.gram)],
					...(idle.some((n) => n > 0) ? { j: idle } : {}),
				}
			: {};
	for (const stream of streams) stream.close();
	return {
		page,
		cursor:
			exhausted || last === null ? null : encodeCursor({ ...last, ...plan }),
		isDone: exhausted,
		scanned: examined,
		verified,
	};
}
