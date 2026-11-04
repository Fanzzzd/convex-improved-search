# Probes rank on 8 rows, and far docs seeks open floored ranges

Issue #13: `TR-260720-006` with `fields: ["cargo"]` on 3650 dispatch Entries
(eight short Fields, the number in every 97th `cargo`) read 1147 rows and
222,224 bytes over 2 calls, against 808 rows and 153,134 bytes for the patched
0.4.0 build the reporting app ran before, and took 1157, 1144 and 1499 ms over 3
traversals against 672, 994 and 1213 ms. convex-test's row and byte counts match
the real engine's for this corpus exactly.

The probe read 32 postings of each of the 13 query Grams in the first call:
about 384 rows and 45 KB, most of them from Grams every Entry holds. The time
went elsewhere (below).

## Probes

Every probed Gram reads 8 rows (PROBE_FIRST_ROWS) and is ranked by how far back
its 8th row lies. The sparsest 6 (PROBE_DEEP: the plan's CHECK_GRAMS + 1 and two
more) read on to 32 rows from the range already open, so this adds no range, and
are ranked again on their 32 rows. A Gram dense near the cursor costs 8 rows
instead of 32. A query with 6 Grams or fewer probes as before.

Eight rows misrank a Gram whose first rows cluster: on issue #13's corpus `0-`
holds the 10 newest Entries and then 1 in 10, so it looks dense on 8 rows and is
the sparsest on 32. With 4 Grams read deep, a Gram every Entry holds (`tr`) took
a check's place. Field tags hid that on the scoped query; without `fields`, or
on untagged postings, the query read 18% and 23% more than 0.5.2. With 5 deep it
read less than 0.5.2 on all three, and 6 leaves a margin.

## Floored docs ranges

On a disposable local engine (`precompiled-2026-10-22-1447815`), one query
reading 1 or 2 docs rows from a 3650-doc table took, per range:

| Range                                      | ms per range |
| ------------------------------------------ | ------------ |
| `sortKey ≤ s`, open to the namespace's end | 7 to 10      |
| `sortKey ≤ s` and `≥` the sortKey 97 below | 1            |
| `sortKey ≤ s` and `≥` the sortKey 3 below  | 0.2          |
| One key (`by_ns_key`, `.first()`)          | 0.15         |

The engine reads ahead of the last row a range returned, and on an open range
that read-ahead costs several times the rows used. Reading 104 rows from one
open range took 26.6 ms, from a range holding exactly those rows 3.9 ms. Issue
#13's first page reopened the docs stream 36 times.

So when the docs stream reopens at a far candidate (one past its 2-row walk),
the range stops at the sortKey of the candidate stream's next posting, read one
row ahead for it. Postings mode needs no doc below that posting before it reads
the posting. When the walk reaches the floor before the next candidate (a
rejected posting lay between), the stream opens the rest as before. That range
is this call's choice, not evidence of a far candidate, so it does not count in
`wasted`, and the row a floored range's end costs is refunded. Counting the
range gave W19 `07-2607` an extra call.

The posting is read ahead only for a far reopen. Reading it for every candidate
cost limit-1 pages a row per call (W20 limit 1: 9% more rows). Only the far
reopen is floored: flooring every docs range at the next posting cost a range
per candidate in dense stretches (`TR-26` on issue #13's corpus: 919 to 3659
ranges), and flooring check streams too raised W5 to 1.051.

## Results

Issue #13's corpus, pages of 20, budget 512, bytes:

| Query                                      | 0.5.2     | This      |
| ------------------------------------------ | --------- | --------- |
| `TR-260720-006`, `cargo`                   | 222,224   | 199,276   |
| `TR-260720-006`, no `fields` (5-call fill) | 228,695   | 205,709   |
| `TR-260720-006`, untagged postings         | 203,191   | 183,886   |
| `TR-260720-999999`, `cargo`                | 75,582    | 56,384    |
| `ROUTE-ONLY`, `cargo` (no hit)             | 76,319    | 65,169    |
| `ROUTE-ONLY`, `route`                      | 395,475   | 385,835   |
| `TR-26`, `cargo` (3650 hits)               | 3,652,132 | 3,652,132 |

One-Gram queries (`香港`, `香`) use the reader of ADR-0013 and do not change.

All 49 benchmark workloads against 0.5.0 (the 45 at 10000 and 40000 numbers in
one run, the four at 160000 in another), each within 5% on bytes and rows, no
extra call, same hits, at most 1.05 times its combined load:

| Total over 49 | 0.5.0      | 0.5.2      | This       |
| ------------- | ---------- | ---------- | ---------- |
| Calls         | 2,366      | 2,357      | 2,350      |
| Ranges        | 10,130     | 14,032     | 13,628     |
| Rows          | 243,591    | 207,053    | 191,296    |
| Bytes         | 44,502,686 | 36,808,161 | 34,460,712 |
| Hits          | 36,009     | 36,009     | 36,009     |

W19 exact at 160000 numbers takes 4 calls instead of 7 and 0.47 of 0.5.0's load.
The closest to the limit is still W5 (hostile corpus, 1.050, as in 0.5.2).
Against 0.5.2, the `TR-26` drains (W2, W2', W10b) spend 5% more combined load in
ranges, at the same bytes.

## Rejected

- A check that reads more than it rejects sits out (in load units, after its
  second judgment), and counts as settled for the docs-mode judgment. The scoped
  issue #13 query fell to 161,849 bytes, but it let the unscoped and untagged
  queries enter docs mode in the run of 2026-07-20 to 07-29, and leaving
  replanned from that window, where `07` and `tr` are both in every Entry:
  269,696 and 249,547 bytes, 18% and 23% more than 0.5.2. Without the docs-mode
  part, W18 never entered docs mode (53 to 622 ranges).
- Counting the rows and bytes of rejected doc reads as wasted, beside their
  ranges: W19 `07-2607` (no hits, every Gram common) rose to 1.21 times 0.5.0's
  load as checks kept reopening where doc reads are cheap.
