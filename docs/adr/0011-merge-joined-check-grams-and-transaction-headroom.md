# Check Grams are merge-joined, postings carry Field tags, and each call caps itself at the transaction's headroom

In 0.4.0 a `search` call probed the first 8 query Grams with a 17-row cap,
streamed the sparsest, and checked each candidate against 3 more Grams with
one point lookup each, then read its doc: 4 index ranges per candidate. On
document numbers that share a prefix (`TR-260720-006` among 3650
`TR-26MMDD-NNN`), every probed Gram is in every Entry, so all probes tie,
the call streams every Entry, and one `budget: 512` call spends 2057 index
ranges without finishing. A caller that looped five such calls inside one
query hit Convex's 15 s database-time limit in production
(SystemTimeoutError).

## Merge-join

A call probes up to 16 distinct Grams (evenly spaced over long queries)
from the Cursor onward and ranks a full probe by how far back its last row
lies. It streams the sparsest Gram and walks the next three as Check Gram
streams in the same (sortKey, key) order. A candidate missing a Check Gram
is rejected for the rows streamed to reach it.

Every stream, the candidate stream included, moves by one seek. A seek
walks up to 16 rows toward its target. It then reopens at the target's
sortKey (one range). If it is still inside the target's tie group after 16
more rows, it reopens at the exact (sortKey, key) (one range). An index
range cannot express "after (s, k)" in one bound, so the exact seek reads
the tie group first and opens `sortKey < s` only when a later seek needs
it. A seek costs at most 32 rows and 3 ranges, however many Entries share
a sortKey. Probe estimates can be wrong (`60` in that corpus only exists
in Jan to Sep numbers), and the reopen bounds what a wrong estimate costs.

On the W1 benchmark, 8, 16, 32 and 64 walk rows cost 170, 116, 97 and 93
ranges for 1662, 2183, 2786 and 3797 rows. 16 is the last step where the
ranges saved outweigh the rows added at the ratio of Convex's limits
(4096 ranges to 32000 rows).

## Field tags

Each posting lists the Fields whose text holds its Gram. A match lies
inside one Field, so some wanted Field must appear in the tag of every
query Gram. A candidate whose stream and Check Gram tags share no wanted
Field is dropped before its doc read. With `fields: ["memo"]` on that
corpus, a drain of `TR-26` fell from 3714 to 158 ranges.

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

## Headroom

Every call reads `ctx.meta.getTransactionMetrics()`. It caps its ranges
and rows at what the transaction has left minus a reserve for the caller
(512 ranges, 4096 rows), and its doc reads at the bytes left minus 2 MiB,
divided by the largest doc size. When a cap binds, it returns a short Page
with a Cursor (ADR-0006) instead of overrunning. Backends without the
metrics call get the static caps only. The 15 s database-time limit
cannot be measured from inside a query, so no reserve covers it.

## Order

Comparisons use `compareValues` from `convex/values`, the index's own
order (UTF-8 for strings, -0 below 0), so the Cursor and the merge-join
agree with what the index returns. The Cursor keeps the sign of a -0
sortKey, which JSON drops. Sort keys are compared with `Object.is`. A
posting whose sortKey disagrees with its doc is stale and rejected; the
live posting nominates the Entry.

## Rejected

- Point lookups for Check Grams: one range per candidate per Gram, the
  0.4.0 cost.
- A larger fixed probe cap alone: it still ties on any corpus larger than
  the cap.
- Filter values on postings. A filter change, which today replaces one
  docs row, would rewrite every posting of the Entry, and a stale value
  would drop a true match. A selective filter over a common substring
  keeps costing one range per rejected candidate; the README points such
  callers to a namespace per filter value.
- Field-qualified Grams (`field + gram` as the index key). Queries without
  `fields` would then union one stream per Field.
