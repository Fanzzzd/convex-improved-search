# One-Gram queries read each candidate's doc by key

ADR-0012 rejected reading each nominated candidate's doc by key: postings mode
then sees no docs between its candidates, and the Check Grams' backoff and the
docs-passed estimate lose their evidence. That holds for a query with several
distinct Grams. A query with one Gram (two codepoints, or a repeat like `aaa`)
or one codepoint has no Check Gram, so nothing depends on that evidence. For
those queries the docs walk only saved rows, and it cost latency.

On a disposable local engine, 3650 payable-shaped Entries, 60 paired rounds
(patched 0.4.0 reads each candidate's doc by key, in parallel batches):

| Query                   | Patched 0.4.0 | 0.5.1  |
| ----------------------- | ------------- | ------ |
| `香港`, `fields: route` | 117 ms        | 733 ms |
| `香`, `fields: route`   | 89 ms         | 714 ms |
| `香港`, every Field     | 130 ms        | 786 ms |
| `香港`, filter misses   | 36 ms         | 507 ms |

A range open to the namespace's end returns rows several times slower than one
bounded on both sides, at the same rows and bytes. 0.5.1 reopens such a range at
every sparse candidate, one after another.

## Routing

`search` counts the distinct Grams of the folded query. More than one goes to
the reader of ADR-0011 and ADR-0012 (`src/shared/checkedLocalSearch.ts`),
unchanged in planning, with the byte guard below. One Gram or one codepoint goes
to the reader in `lib.ts`, which:

- streams the Gram's postings (or the g1 index) and rejects a candidate by its
  posting's Field tags, as before;
- reads each nominated candidate's doc with one `by_ns_key` range, up to 32 at
  once. Pages of 32 or fewer start with full rounds. Longer pages read one doc
  first so they can try adjacency (below), then full rounds;
- keeps docs mode and its judgments (ADR-0011), with a doc read counting one doc
  passed per candidate until a docs window measures more.

## Rules that keep ranges down

Each point read costs a range, so a dense stretch would cost a range per match.

- **Ties.** When every candidate of a round shares one sortKey, the round reads
  them with one `by_ns_sort` range bounded by that sortKey and the first and
  last keys. Row i must be candidate i. On the first mismatch it stops, stops
  merging for the rest of the call, and point-reads the rest. One extra row,
  range and maximum-doc reservation covers the failed look. W9 (40 Entries at
  sortKey -0, pages of 7) costs 13 ranges, against 47 without merging and 16 for
  0.5.0.
- **Adjacency trial.** Once per call, when every candidate read so far matched,
  at least 32 page slots and 32 budget remain, and no field scope can prune by
  tags, the reader opens the docs index just after the last handled candidate.
  If the next candidate is the very next doc, it enters docs mode with a short
  window. Without the all-matched condition, a dense query with a rare filter
  read 8.5% more (combined load); with it, 1.6%. Without the field-scope
  condition, a scoped query took 2 calls and 885 KB instead of 1 call and 144
  KB.
- **Bounded docs windows.** A docs window entered from postings mode stops at
  the next candidate's sortKey (`docsFloor`), which postings mode would read
  next anyway. Reaching the floor before the window fills drops it, and the walk
  continues open-ended.

## Bytes

- Every queued doc read reserves 1 MiB, Convex's maximum document size, until it
  resolves. Without it, 32 docs with 600 KB filters read in one round came to
  18.6 MB, past the 16 MiB transaction limit.
- Rows are sized with `getConvexSize` (`src/shared/rowSize.ts` computes the same
  number faster for the known Doc and Posting layouts, and falls back to the SDK
  for anything else). JSON length undercounts numeric filters: a JSON-sized
  budget read 17.98 MB over 662 docs with numeric filters.
- The several-Gram reader checks the transaction's remaining bytes before every
  optional row and stops at 5 MiB, enough for the caller, one maximum-size row
  and a fallback. If it stops before handling any candidate, it reads exactly
  one (its posting and its doc) so the cursor moves. 0.5.1 failed with "Too many
  bytes read" after a caller had read 16 docs of 900 KB (17.1 MB), and on
  Entries with 768 long Field names (26.1 MB). Backends without
  `getTransactionMetrics` keep the estimate-based budget of ADR-0011.

## Module layout

The bundler makes every file in the component directory an entry point and
splits code two entry points share into a chunk that each call loads. `grams`,
`limits`, `rowSize` and the several-Gram reader live in `src/shared/`, outside
the component directory, so each lands in `lib.js` once. The several-Gram reader
builds its constants and helpers inside the function: dynamic `import()` is
unsupported in the Convex runtime.

## Results

All 49 benchmark workloads against 0.5.0 (the 45 at 10000 and 40000 numbers in
one run, the four at 160000 in another). Combined load is ranges +
rows·4096/32000 + bytes/4096, a share of the transaction limits, not a bill.

| Total over 49 | 0.5.0      | This       | Ratio |
| ------------- | ---------- | ---------- | ----- |
| Calls         | 2,366      | 2,357      | 0.996 |
| Ranges        | 10,130     | 14,032     | 1.385 |
| Rows          | 243,591    | 207,053    | 0.850 |
| Bytes         | 44,502,686 | 36,808,161 | 0.827 |
| Hits          | 36,009     | 36,009     | 1.000 |
| Combined load |            |            | 0.949 |

No workload reads more than 5% more bytes or rows, makes an extra call, or
exceeds 1.05 times its combined load. The closest is W5 (hostile corpus, 1.049).
The most ranges and rows one call spent were 147 and 4096.

Latency, same setup as above, median of paired ratios:

| Query                   | This   | / patched 0.4.0 | / 0.5.1 |
| ----------------------- | ------ | --------------- | ------- |
| `香港`, `fields: route` | 97 ms  | 0.828           | 0.133   |
| `香`, `fields: route`   | 92 ms  | 1.038           | 0.129   |
| `香港`, every Field     | 111 ms | 0.836           | 0.140   |
| `香港`, filter misses   | 39 ms  | 1.081           | 0.075   |

The single codepoint's 95% interval is 1.022 to 1.060.

## Costs

- Ranges rise 38.5% in total. Rows and bytes fall more, so combined load falls.
- A filter that rejects every candidate is 8% slower than patched 0.4.0.
- Queries with several Grams keep 0.5.1's latency. Against patched 0.4.0 an
  identifier query measured 1.58 times and an excluded-Field query 4.17 times
  (on an earlier build with the same several-Gram reader).

## Rejected

- Point reads for queries with several Grams: ADR-0012's reasons stand.
- `.unique()` instead of `.first()` for the point read: same results, no
  measured latency change.
- Adjacency trials gated only on a nonempty page (see the all-matched condition
  above).
