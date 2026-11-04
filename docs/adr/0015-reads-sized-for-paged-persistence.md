# Reads sized for paged persistence

ADR-0012 to ADR-0014 timed the reader on a local engine backed by SQLite. That
engine's persistence (`crates/sqlite/src/lib.rs`, `_index_scan_inner`) ignores
the size hint and loads the whole interval of every range into memory before
returning its first row. So a range cost what its bounds enclosed, about 4 to 5
ms per 1000 rows, whatever the reader used: 48 ms for 3 ranges over a 3600-row
interval, 8 ms over a 400-row one.

Paged persistence (Postgres, MySQL) reads in batches. The query layer
(`database/src/query/index_range.rs`) asks for `prefetch_hint` rows per fetch,
or `DEFAULT_QUERY_PREFETCH` = 100 when the query sets no limit, and `.limit(n)`
lowers the hint to n. The isolate's `queryStreamNext` passes no hint of its own.
Rows fetched ahead and never returned are not charged to the transaction (reads
are recorded per row returned), but the database fetches them and the backend
decodes them.

Rerun on the same engine binary with `--db postgres-v5` against a loopback
Postgres, the issue #13 scenarios turned around: 0.5.2 took 2 to 4 times as long
as the patched 0.4.0 build (original query 49 → 192 ms), and the build of
ADR-0014 about the same. patched 0.4.0 reads with `.first()`, `.take(17)` and
`.unique()`, all limited; 0.5.x opened unlimited ranges and used 2 rows of the
100 each fetched.

## What a range costs here

On that engine, 36 reopens reading 2 docs each:

| Range                 | ms  |
| --------------------- | --- |
| unlimited             | 40  |
| `.limit(3)`           | 10  |
| `.limit(32)`          | 19  |
| floored 97 rows below | 40  |
| floored 3 rows below  | 9   |

So about 0.25 ms per range plus about 8.5 µs per docs row fetched. A floor helps
only when it encloses fewer than 100 rows; on issue #13's corpus the floor of
ADR-0014 lies about 97 docs down, so it saves little here. It stays: it costs
nothing.

Reads pending at once go out as one batch (`async_syscall.rs` groups
`queryStreamNext` calls): 32 point reads take 8.3 ms one after another and 3.9
ms side by side. On SQLite they did not overlap. And each
`ctx.meta.getTransactionMetrics()` is a round trip out of the isolate, about 10
µs on this machine: 0.5.x made one before every row.

`pg_stat_statements` counts the rows Postgres returns per statement, which is
the prefetch the transaction metrics do not show. The bench in the research
notes records it beside wall time.

## Changes

- **Limits.** A probe range takes `.limit(32)` (it never reads more). A docs
  range in postings mode takes `.limit(4)`; one that reaches its limit goes on
  after its last row with none, and so do later ranges of that stream: it walks
  long runs. Docs mode, the candidate stream and the check streams take none: a
  continuation is one more range. `limit` is the operator `take` is built on and
  Convex's public types leave it out, so the reader checks for it and reads
  ranges whole without it; a test fails if it disappears.
- **Read guard.** It counts down from the last metrics answer by its own
  estimates and asks again near the reserve (estimates doubled) or after 64
  rows. On the real engine with ballast reads pushing the transaction into the
  reserve, with 0.5 KB and 12 KB docs, it stops where 0.5.2 did and never
  overruns.
- **Batched reads.** Probes read their Grams side by side. The first, most
  selective check seeks a candidate alone, and the other checks then seek side
  by side.
- **Docs seeks.** A docs seek reopens at once when, by the sortKey spacing of
  the rows its stream read in sequence, the target lies more than twice the walk
  away. When the next posting lies that far below the target too, it reads the
  target's doc by key (one row) and leaves nothing open; the next seek opens at
  its own target.
- **Idle checks across pages.** A check that rejected nothing carries its
  judgments in the Cursor (`j`) across pages where most verified candidates were
  hits, so on pages of 20 it is dropped after 64 judgments as in one long call.
  Cursors without `j` decode as before; older code ignores it.
- **Far docs in batches.** Once the docs stream has read a far target by key,
  and every check left has judged 16 candidates (on this page or carried) and
  rejected none, the next candidates (at most 8, and no more than the page and
  the budget can take) are checked in order and the docs of those that pass are
  read by key together: one round trip, as patched 0.4.0 reads its candidates'
  docs. Same ranges and rows as reading them one by one. It stops for the call
  once two candidates lie near.
- **Iterators.** A stream ends the query of every range it leaves. Convex keeps
  an unfinished query, and its fetched rows, until the function ends.

Fitted over every bench run, wall time on this engine is about 4 ms + 6.6 ms per
call + 28 µs per row Postgres returned + 15 µs per statement. That fit misleads
on one point. Postings limits on every stream, plus an 8-row first probe range
continued exactly (two ranges, no row read twice), cut the rows Postgres
returned by 20 to 25% and ran no faster than without them, interleaved on the
same engine: `TR-260720-006` 62 against 61 ms, `ROUTE-ONLY` 154 against 147.
Unlimited ranges fetch their rows ahead in bulk, and what costs is the rows the
function is handed (and their bytes), not the rows fetched for it. Ranges are
cheap either way (the gate, re-weighted on 2026-11-04, no longer counts a range
as 8 rows), but trading them for fetched rows buys nothing here.

## Results

Issue #13's scenarios on the Postgres-backed engine, median of 21 interleaved
rounds, pages of 20, budget 512, `fields` given, as the ratio to patched 0.4.0
(the machine ran other work, load average 13 to 46, so the ratios are the
result, not the milliseconds). The ADR-0014 column is from 9 rounds:

| Query                       | ADR-0014 | This |
| --------------------------- | -------- | ---- |
| `TR-260720-006`             | 2.25     | 1.23 |
| `ROUTE-ONLY`, `route`       | 2.14     | 1.09 |
| `TR-260720-999999`          | 1.70     | 0.75 |
| `ROUTE-ONLY`, `cargo`       | 1.12     | 0.58 |
| `香港` (one Gram, ADR-0013) | 0.96     | 0.95 |
| `香` (one codepoint)        | 0.99     | 1.05 |

On 300 docs of 4 KB: `zq7` (a hit every 13th doc) 1.28, 30 against 24 ms, and
`abc` (nearly every doc) 1.07. Each call of `zq7` walks two far docs before the
docs stream knows their spacing and reads by key. Carrying that spacing in the
Cursor cut its bytes 6% and no time, and 0.3% of the bytes over the 49
benchmark workloads below: not worth a Cursor field.

Rows Postgres returned for the first two: 1450 and 2715, against 3981 and 7742
before, and 872 and 2916 for patched 0.4.0. `ROUTE-ONLY` pages after its idle
checks drop run at 11 ms against 12.5 ms for patched 0.4.0; its first four pages
still run checks that never reject. `TR-260720-006` reads its docs by walking
(its candidates lie near), so batches do not apply. It hands the function 939
rows and 177 KB against 808 rows and 153 KB for patched 0.4.0: probes read 248
rows (patched 0.4.0: 136), and the checks read 138 before they fall behind and
sit out. Cutting its prefetch did not help (above).

The 45 benchmark workloads at 10000 and 40000 numbers and the four at 160000
pass against 0.5.0: no workload above 5% more bytes or rows, no extra call, same
hits, at most 1.05 times its combined load (closest: W5, 1.044).

| Total over 49 | 0.5.0      | ADR-0014   | This       |
| ------------- | ---------- | ---------- | ---------- |
| Calls         | 2,366      | 2,350      | 2,330      |
| Ranges        | 10,130     | 13,628     | 13,684     |
| Rows          | 243,591    | 191,296    | 182,666    |
| Bytes         | 44,502,686 | 34,460,712 | 33,060,536 |
| Hits          | 36,009     | 36,009     | 36,009     |

Combined load over the 49: 0.865 of 0.5.0's, 0.971 of ADR-0014's.

Issue #13's corpus, bytes:

| Query                           | ADR-0014  | This      |
| ------------------------------- | --------- | --------- |
| `TR-260720-006`, `cargo`        | 199,276   | 176,507   |
| same, no `fields` (5-call fill) | 205,709   | 179,495   |
| same, untagged postings         | 183,886   | 157,040   |
| `TR-260720-999999`, `cargo`     | 56,384    | 56,384    |
| `ROUTE-ONLY`, `route`           | 385,835   | 180,934   |
| `ROUTE-ONLY`, `cargo` (no hit)  | 65,169    | 65,169    |
| `TR-26`, `cargo` (3650 hits)    | 3,652,132 | 1,972,893 |

## Ablation

Each change above taken out alone, on the Postgres-backed engine, 21 to 31
interleaved rounds against the build with all of them, over issue #13's
scenarios plus two on 300 docs of 4 KB (`zq7`, a hit every 13th doc; `abc`,
nearly every doc). The same build against itself came out 0.98 in total and 0.95
to 1.01 per scenario, so a scenario moves only past about 5%.

| Taken out                   | Slower where                                       |
| --------------------------- | -------------------------------------------------- |
| Probe limit                 | `TR-260720-999999` 1.15, `ROUTE-ONLY` `cargo` 1.15 |
| Probes side by side         | `TR-260720-999999` 1.33, `ROUTE-ONLY` `cargo` 1.23 |
| Checks side by side         | `TR-260720-006` 1.20                               |
| Read guard countdown        | 1.13 to 1.18 on four scenarios, 1.065 in total     |
| Idle checks across pages    | `ROUTE-ONLY` `route` 1.37, and 52% more rows       |
| Far docs in batches         | `ROUTE-ONLY` `route` 1.33                          |
| Docs read by key            | `ROUTE-ONLY` `route` 1.34, `zq7` 1.13              |
| Docs seeks reopening at far | `ROUTE-ONLY` `route` 1.34, 75% more bytes there    |
| Docs limit                  | `TR-260720-006` 1.13 and 1.08 (`abc` 0.92, 0.97)   |
| Closing iterators           | none (1.015 in total)                              |

Closing iterators stays: it bounds what a call holds, up to 100 fetched rows for
each of its ranges. Three changes did not survive and are gone: the next posting
read beside the checks (0.996 and 0.991 without it), a native comparison in
place of `compareValues` (1.03 and 0.99), and a docs limit that grew fourfold
per continuation. Each continuation reads the last row again, a whole doc on the
`abc` corpus, so the limit now ends at the first one: the same time (1.000,
1.001), 4% fewer bytes on `abc`.

## Rejected

- Reading the candidate's doc beside its checks: every rejection wastes the doc.
  W5 1.0555 and W19 `07-2607` 1.065 of 0.5.0's load.
- All checks side by side while candidates kept passing: W19 `07-2607` 1.058.
- Limits on posting streams: postings fetched for route-selected fell from 3324
  to 2197, but continuations cost ranges, W5 1.053 and W19 prefix 1.084.
  Reopening at the target instead of continuing, when a seek reached the limit,
  changed which checks sat out: W19 `07-2607` took 8 calls instead of 5.
- Carrying idle judgments on every page: on W20 at budget 2 the docs reject what
  the checks pass, a dropped check was missing where the corpus changed, and it
  took 260 calls instead of 259. Dropping carried checks at 32: W20 at limit 1
  read more than 5% more rows.
- Trying a point read on a stream's first open of the call: deciding reads the
  next posting for the floor, a row a first open never read. Pages of 1 read 20%
  more rows.
- Batching docs while checks reject or sit out: the batch reads docs a resumed
  check would have spared. W1 and W10 1.082 of 0.5.0's load.
- Running the next candidate's checks beside this one's doc read, and the doc
  beside the next posting's read: no change in latency beyond noise. Batched
  reads cost round trips, but the backend does the reads one after another.
- Probing 8 Grams instead of 16: `TR-260720-006` on issue #13's corpus read 3%
  fewer bytes, but W1, W10 and W19 exact took 1.39 to 1.54 times the load of the
  build without it (worse plans).
- Dropping a check that rejects under a quarter of 32 or more judgments: on
  `TR-260720-006` the checks fall behind and sit out after a few judgments, so
  it never applied.
