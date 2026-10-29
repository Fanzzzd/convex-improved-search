# Search walks sorted streams: merge-joined Check Grams, Field-tagged postings, docs in step, and a per-transaction headroom

In 0.4.0 a `search` call probed the first 8 query Grams with a 17-row cap,
streamed the sparsest, and checked each candidate against 3 more Grams with one
point lookup each, then read its doc: 4 index ranges per candidate. On document
numbers that share a prefix (`TR-260720-006` among 3650 `TR-26MMDD-NNN`), every
probed Gram is in every Entry, so all probes tie, the call streams every Entry,
and one `budget: 512` call spends 2057 index ranges without finishing. A caller
that looped five such calls inside one query hit Convex's 15 s database-time
limit in production (SystemTimeoutError).

Every index this plan reads is ordered by (sortKey, key) after its equality
prefix: postings by Gram, postings by first codepoint, and docs by namespace
(`by_ns_sort`). So the candidate stream, each Check Gram and the docs are all
one kind of SortedStream, walked DESC in lockstep, and every lookup is the same
move: seek forward to a position.

## Seek

A seek walks up to `walk` rows toward its target. It then reopens at the
target's sortKey (one range). If it is still inside the target's tie group after
`walk` more rows, it reopens at the exact (sortKey, key) (one range). An index
range cannot express "after (s, k)" in one bound, so the exact seek reads the
tie group first and opens `sortKey < s` only when a later seek needs it. A seek
costs at most 2·walk+1 rows and 3 ranges plus one to open below a drained tie
group, however many Entries share a sortKey.

Walk lengths: 16 for postings, 64 for the one resume per call (an exact seek
inside a short tie group would cost a second range when the group drains), 8 for
docs (larger rows). A walk also ends after 16 KiB of walked rows: past a sparse
hit among max-size docs (W12), one reopen is cheaper than eight 16 KiB rows, and
that walk fell from 7.14 to 1.61 MB. On the W1 benchmark the postings walk at 8,
16, 32 and 64 cost 170, 116, 97 and 93 ranges for 1662, 2183, 2786 and 3797
rows; 16 is the last step where the ranges saved outweigh the rows added at the
ratio of Convex's limits (4096 ranges to 32000 rows).

## Check Grams

A call probes up to 16 distinct Grams (evenly spaced over long queries) from the
Cursor onward and ranks a full probe by how far back its last row lies. A query
with one distinct Gram skips the probe. The sparsest Gram is the candidate
stream; the next three are Check Grams.

A Check Gram stream does not reopen to reach a candidate. If it cannot walk to
one within 16 rows, it could only reject the candidate for a range, and the docs
stream decides the same candidate for at most one range. It sits out later
candidates, since walking on from behind would spend 16 rows on each of them.
Reopening every time cost W1 115, W2' 160 and W8 320 ranges; walking on from
behind cost 62, 55 and 120; sitting out for the rest of the call cost 53, 46
and 120.

Sitting out for good loses a check that is dense early and decisive later (W13:
106 ranges, against 69 for reopening). So a check that sat out reopens once when
the docs stream has spent 4 more ranges reaching candidates their doc then
rejected, and the wait doubles each time it falls behind again. Wasted ranges,
not wasted verifications, are the evidence: in W1 the check `06` rejects 85
candidates that cluster in doc order, so the docs walk would have reached them
for free, and reopening on rejected verifications raised W1 from 53 to 65
ranges. With wasted ranges W1 stays at 53 and W13 drops to 44.

A check that has judged 64 candidates without rejecting one is dropped: its rows
buy nothing (W11's three checks, which every Entry holds).

A check that rejects more than half of 16 or more candidates is sparser than the
candidate Gram here: the probe ranked them wrong, or the corpus changes along
the order. It becomes the candidate stream, and the old one a check, once it has
been walked to the current candidate. Every match holds both Grams and the check
stream has no unhandled row above its head, so the swap loses nothing. W14 (a
probe that misjudges the candidate Gram) costs 83 ranges / 1314 rows; without
the swap a carried plan kept the wrong candidate until the call's row cap, 87
/ 5063. A Gram may swap back: on W7 the second swap saves rows (899 against 1562
when a swapped-out Gram stays out).

The Cursor carries the plan (candidate Gram, then the Check Grams still in use)
as `g`, so the next page skips probing, unless a check still rejects most of
what it judges, which sends the next page back to the probe. W11, 15 pages, fell
from 255 to 45 ranges, 180 of which were probes. Old Cursors without `g` still
decode and probe.

## Field tags

Each posting lists the Fields whose text holds its Gram. A match lies inside one
Field, so some wanted Field must appear in the tag of every query Gram. A
candidate whose stream and Check Gram tags share no wanted Field is dropped
before its doc. With `fields: ["memo"]` on that corpus, a drain of `TR-26` fell
from 3714 to 158 ranges (before the docs stream).

`set` patches the tag inline whenever a Gram enters or leaves a Field, and
patches every row of the Gram, duplicates included. A duplicate at the current
sortKey with a stale tag would drop a true match. Renaming the Field of a large
text changes every tag, which can exceed the 3000-patch limit that a sortKey
change is refused at. Such a `set` patches only the sortKeys and writes a
`retagging` row; `reapKey` retags the rest and deletes the row once one
transaction has walked all the Entry's postings. A call that is about to reject
a candidate by tags reads the namespace's `retagging` rows once (one range) and
ignores the tags of those Entries. Past 64 such rows it ignores all tags.

Postings written before 0.5.0 have no tag and allow every Field. An unchanged
`set` reads one posting to detect them, so re-running a backfill tags an
existing namespace.

Single-codepoint queries skip tags: each g1 row tags its own Gram, and only the
union over an Entry's rows would describe the codepoint.

## Docs in step

A nominated candidate is verified against the docs row at its own (sortKey,
key), found by seeking the docs stream. Dense candidates cost a few streamed
rows each instead of one range each; a far candidate costs one range, as the
point read did. No live doc at that position means the Entry is gone or the
posting is stale (its doc has moved to another sortKey), which is the rejection
the point read made by comparing sortKeys. On the fixed benchmark: `停車` first
page 51 → 2 ranges, a 1 in 100 filter drained 3012 → 24, the hostile corpus
32344 → 3278 (rows 95459 → 131739), W11 (tags reject nothing) 3890 → 255.

## Docs alone

Docs mode walks the docs alone and verifies each one. The docs stream holds
every Entry, so this is the oracle itself and loses nothing; only the cost
differs.

Each mode is judged by the load it puts on the transaction per doc passed: rows
read times 4096/32000 plus bytes read times 4096/16 MiB, the shares of Convex's
row and byte limits in range units. Ranges stay out of both sides. Docs mode
reads one doc row per doc. Postings mode measures what it read since its last
judgment: candidate and check postings, and the docs its walk read. Docs passed
there is a lower bound, the docs the walk read plus one more walk for each
reopen, and at least one doc per candidate. It switches to docs when its load
per doc passed reaches a doc row's. It judges every 32 verifications or every
window of docs passed, and only once every check has rejected a candidate (by
position or by tags) or judged 16. Until then a check may still be dropped or
swapped, and the plan it measures is not the one it will run. A check whose tags
reject candidates is never dropped as idle.

Docs mode estimates what postings mode would read over a window of 128 docs, or
half the call's budget when that is smaller. It counts the docs holding each
sampled Gram (up to 16) in a wanted Field. The estimate adds the sparsest Gram's
postings, each next Gram's postings up to 16 per candidate (a check's walk), and
the docs walk to every doc holding all sampled Grams in one Field: from each, at
most 8 docs back to the one before. When that is less than the window's doc
rows, it leaves. A call that ends inside a window judges the docs it has, given
16 of them, so a limit of 1 or a budget of 1 leaves docs mode too.

Leaving replans from the window: the Gram the fewest docs held streams, the next
three check, and a Gram already streamed keeps its stream. A call that leaves at
its end writes that plan into the Cursor. A call that ends in docs mode writes
`d: 1` and no plan, so the next page starts there without a probe.

Earlier rules failed on the round 4 and 5 judges' workloads:

- Entering on the share of verified docs that hold every sampled Gram: W22 (停車
  and 車費 in separate Fields of every doc) never entered, yet postings read two
  rows per doc against one. L 1035 → 2014.
- Judging only after a full window: a page that ended first kept `d: 1` for
  good. W20b at budget 1 took 11601 calls instead of 117.
- Measuring a plan whose checks had not shown what they do: W1 entered docs mode
  on checks that would have been dropped. L +25%.
- Charging the docs walk as 8 docs per dense doc, spread evenly: W20 at limit 2
  left a dense stretch one window late. L +6%.
- A window of 96 docs or less: the incident corpus holds `7-` in runs of 100
  docs, and a window inside a run misjudges it. W19 `07-2607` at 5000 numbers
  +18%.

Against 4c9bea6, measured by L (ranges + rows·4096/32000 + bytes·4096/16 MiB):

| Workload                          | Change in L  |
| --------------------------------- | ------------ |
| W15, W16, W12b                    | −62% to −75% |
| W17 / W18                         | −50% / −38%  |
| W20, limits 5 / 50                | −74% / −75%  |
| W21                               | −13% to −16% |
| Incident query, 10k / 40k numbers | −46% / −66%  |
| No-hit query, 10k / 40k numbers   | −14% / −33%  |
| Every other workload              | −4% to +2%   |

## Headroom

Every call reads `ctx.meta.getTransactionMetrics()`. It caps its ranges, rows
and bytes at what the transaction has left minus a reserve for the caller (512
ranges, 4096 rows, 2 MiB). One CallBudget charges every stream: a row before it
is read, its bytes (its JSON in UTF-8, near enough) after. When a cap binds, it
returns a short Page with a Cursor (ADR-0006) instead of overrunning. Without
the metrics call a call takes a quarter (CALLS_PER_TRANSACTION, the most a
`fill` or a sharded search makes) of a fresh transaction's limits less the
reserves. The 15 s database-time limit cannot be measured from inside a query,
so no reserve covers it.

## Order

Comparisons use `compareValues` from `convex/values`, the index's own order
(UTF-8 for strings, -0 below 0), so the Cursor and every stream agree with what
the index returns. The Cursor keeps the sign of a -0 sortKey, which JSON drops.
Sort keys are compared with `Object.is`.

## Rejected

- Point lookups for Check Grams: one range per candidate per Gram, the 0.4.0
  cost.
- A larger fixed probe cap alone: it still ties on any corpus larger than the
  cap.
- Filter values on postings. Every filter change, which today replaces one docs
  row, would rewrite every posting of the Entry inline or through the reaper
  (the `retagging` mechanism would keep it correct, so the cost is the write
  amplification). Walking docs in step brought the 1 in 100 filter workload to
  24 ranges without it.
- Field-qualified Grams (`field + gram` as the index key). Queries without
  `fields` would then union one stream per Field.
