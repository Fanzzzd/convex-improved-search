# Check Grams are merge-joined, and each call caps itself at the transaction's headroom

In 0.4.0 a `search` call probed the first 8 query Grams with a 17-row cap,
streamed the sparsest, and checked each candidate against 3 more Grams with
one point lookup each, then read its doc: 4 index ranges per candidate. On
document numbers that share a prefix (`TR-260720-006` among 3650
`TR-26MMDD-NNN`), every probed Gram is in every Entry, so all probes tie,
the call streams every Entry, and one `budget: 512` call spends 2057 index
ranges without finishing. A caller that looped five such calls inside one
query hit Convex's 15 s database-time limit in production
(SystemTimeoutError).

Now a call probes up to 16 distinct Grams (evenly spaced over long queries)
from the Cursor onward, ranks a full probe by how far back its last row
lies, streams the sparsest Gram and walks the next three as Check Gram
streams in the same (sortKey, key) order. A candidate missing a Check Gram
is rejected for the rows streamed to reach it. When a Check Gram stream is
more than 8 rows away, it reopens at the candidate's sortKey for one range
(probe estimates can be wrong; `60` in that corpus only exists in Jan to
Sep numbers). Only surviving candidates are read. The same query finishes
in one call with 170 ranges.

Every call also reads `ctx.meta.getTransactionMetrics()` and caps its
ranges and rows at what the transaction has left minus a reserve for the
caller, returning a short Page with a Cursor (ADR-0006) instead of
overrunning. Backends without the metrics call get the static caps only.

Comparisons use `compareValues` from `convex/values`, the index's own
order (UTF-8 for strings), so the Cursor and the merge-join agree with
what the index returns. A posting whose sortKey disagrees with its doc is
stale and rejected; the live posting nominates the Entry.

Rejected: point lookups for Check Grams (one range per candidate per Gram,
the 0.4.0 cost), and a larger fixed probe cap alone (still ties on any
corpus larger than the cap).
