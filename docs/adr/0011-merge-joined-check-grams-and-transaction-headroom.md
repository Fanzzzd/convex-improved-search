# Search walks sorted streams: merge-joined Check Grams, Field-tagged postings, docs in step, and a per-transaction headroom

In 0.4.0 a `search` call probed the first 8 query Grams with a 17-row cap,
streamed the sparsest, and checked each candidate against 3 more Grams with
one point lookup each, then read its doc: 4 index ranges per candidate. On
document numbers that share a prefix (`TR-260720-006` among 3650
`TR-26MMDD-NNN`), every probed Gram is in every Entry, so all probes tie,
the call streams every Entry, and one `budget: 512` call spends 2057 index
ranges without finishing. A caller that looped five such calls inside one
query hit Convex's 15 s database-time limit in production
(SystemTimeoutError).

Every index this plan reads is ordered by (sortKey, key) after its
equality prefix: postings by Gram, postings by first codepoint, and docs
by namespace (`by_ns_sort`). So the candidate stream, each Check Gram and
the docs are all one kind of SortedStream, walked DESC in lockstep, and
every lookup is the same move: seek forward to a position.

## Seek

A seek walks up to `walk` rows toward its target. It then reopens at the
target's sortKey (one range). If it is still inside the target's tie group
after `walk` more rows, it reopens at the exact (sortKey, key) (one
range). An index range cannot express "after (s, k)" in one bound, so the
exact seek reads the tie group first and opens `sortKey < s` only when a
later seek needs it. A seek costs at most 2·walk+1 rows and 3 ranges plus
one to open below a drained tie group, however many Entries share a
sortKey.

Walk lengths: 16 for postings, 64 for the one resume per call (an exact
seek inside a short tie group would cost a second range when the group
drains), 8 for docs (larger rows). On the W1 benchmark the postings walk
at 8, 16, 32 and 64 cost 170, 116, 97 and 93 ranges for 1662, 2183, 2786
and 3797 rows; 16 is the last step where the ranges saved outweigh the
rows added at the ratio of Convex's limits (4096 ranges to 32000 rows).

## Check Grams

A call probes up to 16 distinct Grams (evenly spaced over long queries)
from the Cursor onward and ranks a full probe by how far back its last row
lies. A query with one distinct Gram skips the probe. The sparsest Gram is
the candidate stream; the next three are Check Grams.

A Check Gram stream never reopens. If it cannot walk to a candidate within
16 rows, it could only reject the candidate for a range, and the docs
stream decides the same candidate for at most one range. The call drops
that Check Gram for the rest of the call, since walking on from behind
would spend 16 rows on every later candidate. Probe estimates can be wrong
(`60` in that corpus only exists in Jan to Sep numbers); a wrong estimate
now costs one dropped stream. Reopening checks instead cost W1 115, W2'
160 and W8 320 ranges; never reopening but walking on cost 62, 55 and 120;
dropping costs 53, 46 and 120.

## Field tags

Each posting lists the Fields whose text holds its Gram. A match lies
inside one Field, so some wanted Field must appear in the tag of every
query Gram. A candidate whose stream and Check Gram tags share no wanted
Field is dropped before its doc. With `fields: ["memo"]` on that corpus, a
drain of `TR-26` fell from 3714 to 158 ranges (before the docs stream).

`set` patches the tag inline whenever a Gram enters or leaves a Field, and
patches every row of the Gram, duplicates included. A duplicate at the
current sortKey with a stale tag would drop a true match. Renaming the
Field of a large text changes every tag, which can exceed the 3000-patch
limit that a sortKey change is refused at. Such a `set` patches only the
sortKeys and writes a `retagging` row; `reapKey` retags the rest and
deletes the row once one transaction has walked all the Entry's postings.
A call that is about to reject a candidate by tags reads the namespace's
`retagging` rows once (one range) and ignores the tags of those Entries.
Past 64 such rows it ignores all tags.

Postings written before 0.5.0 have no tag and allow every Field. An
unchanged `set` reads one posting to detect them, so re-running a
backfill tags an existing namespace.

Single-codepoint queries skip tags: each g1 row tags its own Gram, and
only the union over an Entry's rows would describe the codepoint.

## Docs in step

A nominated candidate is verified against the docs row at its own
(sortKey, key), found by seeking the docs stream. Dense candidates cost a
few streamed rows each instead of one range each; a far candidate costs
one range, as the point read did. No live doc at that position means the
Entry is gone or the posting is stale (its doc has moved to another
sortKey), which is the rejection the point read made by comparing
sortKeys. On the fixed benchmark: `停車` first page 51 → 2 ranges, a 1 in
100 filter drained 3012 → 24, the hostile corpus 32344 → 3278 (rows
95459 → 131739), W11 (tags reject nothing) 3890 → 255. Walked doc rows
count against the bytesRead headroom like verified ones.

## Headroom

Every call reads `ctx.meta.getTransactionMetrics()`. It caps its ranges
and rows at what the transaction has left minus a reserve for the caller
(512 ranges, 4096 rows), and its doc rows at the bytes left minus 2 MiB,
divided by the largest doc size. When a cap binds, it returns a short Page
with a Cursor (ADR-0006) instead of overrunning. Without the metrics call
a call takes a quarter (CALLS_PER_TRANSACTION, the most a `fill` or a
sharded search makes) of a fresh transaction's limits less the reserves.
The 15 s database-time limit cannot be measured from inside a query, so
no reserve covers it.

## Order

Comparisons use `compareValues` from `convex/values`, the index's own
order (UTF-8 for strings, -0 below 0), so the Cursor and every stream
agree with what the index returns. The Cursor keeps the sign of a -0
sortKey, which JSON drops. Sort keys are compared with `Object.is`.

## Rejected

- Point lookups for Check Grams: one range per candidate per Gram, the
  0.4.0 cost.
- A larger fixed probe cap alone: it still ties on any corpus larger than
  the cap.
- Filter values on postings. Every filter change, which today replaces one
  docs row, would rewrite every posting of the Entry inline or through the
  reaper (the `retagging` mechanism would keep it correct, so the cost is
  the write amplification). Walking docs in step brought the 1 in 100
  filter workload to 24 ranges without it.
- Field-qualified Grams (`field + gram` as the index key). Queries without
  `fields` would then union one stream per Field.
