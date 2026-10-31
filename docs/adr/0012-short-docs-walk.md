# The docs stream walks 2 rows before it reopens at a candidate

ADR-0011's docs stream walked up to 8 doc rows toward the next candidate before
it reopened there. A reopen at the candidate reads the candidate's doc as its
first row, so it costs one range and the one row that verification needs anyway.
Every walked row that misses is a doc read for nothing. Doc rows are the largest
rows a search reads, and Convex bills bytes read.

The docs stream now walks 2 rows. The mode judgments, check backoff and
docs-passed estimate keep their 0.5.0 rules and still see the same kind of
evidence (walked docs, reopens and the ranges they cost). One ranking rule
changed with it (below).

## Walk length

On the benchmark, against 8:

| Walk | W1 bytes | W21 block 160 rows | Workloads over 5% worse (bytes or rows) |
| ---- | -------- | ------------------ | --------------------------------------- |
| 8    | 168968   | baseline           | (baseline)                              |
| 4    | 144344   | +0.0%              | 0 of 45                                 |
| 2    | 132032   | −0.0%              | 0 of 45                                 |
| 1    | 125876   | +5.7%              | 1 of 45                                 |

At 1, a stretch where most docs are candidates reopens at nearly every one, and
docs mode, which judges the plan by the walk it would read, enters later.

## Ranking a docs window

Leaving docs mode ranks the sampled Grams by how many docs in the window hold
each one. That count now takes any Field, since a Gram's postings stream holds
every doc whose text holds it in some Field. The count of docs holding all of
them in one Field (`dense`) keeps to the wanted Fields only once the call has
read a tagged posting: an untagged posting allows every Field, so before that
tags reject nothing. With the shorter walk, a payable fixture query with
`fields` on untagged postings entered docs mode, ranked every Gram at 0
wanted-Field holds, and streamed a Gram every doc held: 770112 → 1678221 bytes
over 7 pages. With both counts fixed it reads 574955 bytes over 2.

## Rejected

- Reading each nominated candidate's doc by key (one range, one row) and
  dropping the docs stream from postings mode. It reads no doc it does not
  verify, and on the payable fixture it read 40% to 84% fewer bytes than 0.5.0.
  But postings mode then sees no docs between its candidates, so the checks'
  backoff (counted in rejected reads instead of ranges) and the docs-passed
  estimate lost their evidence. Five benchmark workloads read 5.5% to 20% more
  bytes or rows than 0.5.0 (W19 `07-2607` at 10000 numbers +17% bytes), and four
  rule changes each moved the loss elsewhere. Ranges rose up to 29x (W21 36 →
  1037).
- A per-Gram document count kept on write. It would give the docs-passed
  estimate a prior, but not local density (W21 alternates 62% and 38%) or Gram
  correlation (`07-2607`), and every `set` would write the count rows of common
  Grams, a write conflict on each.
