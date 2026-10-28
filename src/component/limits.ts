import { ConvexError } from "convex/values";

/**
 * Limits shared by the component and the client (which needs them for
 * `fill` and sharded bookkeeping).
 */

/**
 * The `search` calls one transaction is planned for: a `fill` makes at
 * most this many, and a sharded search visits at most this many shards per
 * call. Without transaction metrics a call cannot see what earlier calls
 * spent, so it takes this share of the transaction's limits.
 */
export const CALLS_PER_TRANSACTION = 4;

/**
 * The Scan Budget: how many candidates one `search` call may verify
 * against their docs. A candidate reaches Verification only after it holds
 * every check gram (and, by the postings' tags, some wanted Field). Docs are
 * walked in the candidates' order, so Verification costs rows, plus one
 * index range when the next candidate lies far ahead. Every call in a
 * transaction shares Convex's limits with the caller, so each call also
 * caps itself at what the transaction has left. When the budget runs out
 * before the page fills, the returned cursor covers only what was examined:
 * callers keep paging and matches keep arriving.
 */
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
