import { ConvexError } from "convex/values";

/**
 * Page size and Scan Budget bounds, shared by the component and the client
 * (which needs them for `fill` and sharded bookkeeping).
 *
 * The Scan Budget: how many candidates one `search` call may verify. A
 * candidate reaches Verification only after it holds every check gram (and,
 * by the postings' tags, some wanted Field), and Verification costs one
 * index range (the doc read). Convex allows 4096 index ranges per
 * transaction, shared with the caller and with every other `search` call in
 * it, so each call also caps itself at what the transaction has left. When
 * the budget runs out before the page fills, the returned cursor covers only
 * what was examined: callers keep paging and matches keep arriving.
 */
/**
 * The `search` calls one transaction is planned for: a `fill` makes at
 * most this many, and a sharded search visits at most this many shards per
 * call. Without transaction metrics a call cannot see what earlier calls
 * spent, so it takes this share of the transaction's limits.
 */
export const CALLS_PER_TRANSACTION = 4;

export const DEFAULT_SCAN_BUDGET = 256;
export const MAX_SCAN_BUDGET = 768;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function normalizeLimit(raw: number | undefined): number {
	if (raw !== undefined && !Number.isFinite(raw)) {
		throw new ConvexError("Search limit must be a finite number");
	}
	return Math.max(1, Math.min(Math.floor(raw ?? DEFAULT_LIMIT), MAX_LIMIT));
}

export function normalizeBudget(raw: number | undefined, limit: number): number {
	if (raw !== undefined && !Number.isFinite(raw)) {
		throw new ConvexError("Search budget must be a finite number");
	}
	return Math.max(limit, Math.min(Math.floor(raw ?? DEFAULT_SCAN_BUDGET), MAX_SCAN_BUDGET));
}
