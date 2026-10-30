# Switching between postings mode and docs mode

Research note for ADR 0011 "Docs alone", after the round 6 rejection
(`.judge/rounds.md`, "Round 6 verdict"). No code was changed. Statements marked
**(inferred)** are my own derivation or arithmetic, not something a source says.
Every other claim cites the source it was read in.

## 1. Summary

Recommended rule: one clamped balance with a fixed band, the 2-state work
function rule from metrical task systems.

- Keep one number `b`: how much more postings mode has cost than docs mode over
  the same docs, in L units, clamped to `[-d, +d]`. The Cursor carries `b` with
  the mode.
- Add `postings L - docs L` for each stretch of docs where both sides are known.
  In docs mode that is per doc: the doc row read, against an estimate of what
  postings mode would read for that doc. In postings mode it is per docs-stream
  seek that walked to its target: everything read since the last seek, against
  the doc rows walked. Those rows are exactly the docs passed.
- A docs-stream seek that walked `w` rows and then reopened is a jump. Its docs
  passed cannot be counted. Set `b = -d`.
- Switch to docs mode when `b` reaches `+d`. Switch back when it reaches `-d`.
  The same rule and the same `d` apply both ways, every step, with no windows
  and no settled gate.
- `d` is about one switch's cost in ranges. Try 2 to 4.

Bound, with exact costs: BLS (1992) prove 2n-1 = 3 for two states. The online
cost is at most 3 times the best schedule that may switch, plus a constant. Per
drain, **(inferred)**: `L <= min(L_pure postings, L_pure docs)

- k·(2d + s +
  δ)`. Here `k`is the number of mode phases,`s`the ranges a switch reopens, and`δ`the largest single step. The rule switches only after`2d`of excess has built up, so one switch never costs more than the excess that triggered it. With the jump floor, a stretch the docs stream jumped costs postings mode at most`1 +
  (2 + P)/((w+1)·docRow)` times what docs mode would pay for it (ski-rental
  arithmetic, section 2.4).

No online rule can promise "never worse than either pure mode by more than 5%"
on every input. The deterministic lower bound for two states is 3 times the
switching optimum (BLS 1992, Theorem 1.1 and Section 2). The +5% gate can hold
on the judge's workloads, not as a theorem.

## 2. Sources

### 2.1 Online algorithms with switching cost (metrical task systems)

Borodin, Linial, Saks, "An optimal on-line algorithm for metrical task system",
JACM 39(4):745-763, 1992,
[doi:10.1145/146585.146588](https://doi.org/10.1145/146585.146588); PDF
[cs.huji.ac.il](https://www.cs.huji.ac.il/~nati/PAPERS/bls_online.pdf). The PDF
is a scan. I read it through OCR.

- Theorem 1.1 (p. 747): every metrical task system on `n` states has competitive
  ratio `w(S,d) = 2n - 1`. For our two modes that is 3.
- Section 4 (p. 752) gives the "safe" two-state algorithm. Stay in `s0` until
  the processing cost incurred there equals `d(s0,s1)`. Move, stay until the
  cost in `s1` equals `d`, move back. Each cycle costs exactly `4d`, and any
  offline schedule pays at least `d` per cycle, so the ratio is 4. This rule
  never looks at the other state's cost.
- Section 6 (p. 755) gives the rule behind 2n-1. Let `φ_t(s)` be the least
  offline cost of serving the tasks so far and ending in state `s`. Stay in the
  current state `s̄` "until the time t such that there is some state s such that
  φ_t(s) < φ_t(s̄) - d(s, s̄) and then move to state s". This is the work function
  rule.

Two-state form **(inferred)**: let `Δ = φ(P) - φ(D)`. Each step with costs
`c_P, c_D` gives `Δ := clamp(Δ + c_P - c_D, -d, +d)`, because `φ(P)` can never
exceed `φ(D) + d`, and the same holds the other way round. The rule moves to D
when `Δ` reaches `+d` and back to P when it reaches `-d`. That is the balance
`b` in section 1.

Per-phase bound **(inferred)**: a phase in mode P starts at `Δ = -d` and ends at
`Δ = +d`. The clamp only adds when it cuts off negative steps, so over the phase
`cost_P - cost_D <= 2d + δ`. The same holds for D phases. Summing phases against
one pure mode gives the per-drain bound in section 1.

Mapping:

- States are the two modes. Tasks are docs in index order. `c_D` is one doc
  row's load, plus its share of ranges. `c_P` is what postings mode reads for
  the same docs.
- `d` is the switch distance. Entering docs reopens about 1 range. Leaving
  reopens the candidate stream and up to 3 check streams, so up to 4 ranges plus
  their walks. The round 6 candidate tried "hysteresis 1.5/2" and dropped it as
  hurting (`rounds.md`, "Round 6 candidate"). That was a ratio on per-doc load,
  not a band in L units, so it scaled with nothing the switch costs.
- The rule needs `c_D` while in postings mode. BLS's Section 4 rule does not,
  but it pays `4d` per cycle even where one mode always wins. Section 2.4 says
  where we can measure `c_D`.
- Paging: `b` must survive the page, or a budget-1 drain never builds up `d`.
  Round 5 F1 (W20b: 117 to 11601 calls) was this failure in window form.

Ski rental is the one-switch case: rent until the rent paid equals the buy
price, then buy, which is 2-competitive. Karlin, Manasse, Rudolph, Sleator,
"Competitive snoopy caching", Algorithmica 3, 1988,
[doi:10.1007/BF01762111](https://doi.org/10.1007/BF01762111). I did not read
this paper. The 2-competitive statement is the BLS Section 4 argument cut down
to a single move.

### 2.2 Smooth Scan

Borovica-Gajic, Idreos, Ailamaki, Zukowski, Fraser, "Smooth Scan:
Statistics-Oblivious Access Paths", ICDE 2015, pp. 315-326,
[doi:10.1109/ICDE.2015.7113294](https://doi.org/10.1109/ICDE.2015.7113294), open
PDF on
[EPFL Infoscience](https://infoscience.epfl.ch/entities/publication/0131ef45-c051-46b9-8981-ae40b3edfcf5).
The journal version (VLDB J 27:521-545, 2018,
[doi:10.1007/s00778-018-0507-8](https://doi.org/10.1007/s00778-018-0507-8))
holds the full competitive analysis. I could not download it, so I only read the
ICDE summary of that analysis.

- Section III, "Switching Perils": Switch Scan monitors cardinality and
  "switches completely when a certain cardinality threshold is violated", so
  "even a single extra result tuple can bring a drastically different
  performance". They call this a performance cliff.
- Section III-A: three modes. Mode 1 reads the whole heap page a pointer lands
  on. Mode 2 also reads adjacent pages. Mode 2+ doubles the number of prefetched
  pages when it "notices result selectivity increase".
- Section III-B, Elastic policy: if the local selectivity over the last morphing
  region (Eq. 1, `#Pres_region / #Pseen_region`) exceeds the global selectivity
  (Eq. 2), double the region. Otherwise shrink it.
- Section V-A: Greedy has a CR that grows with table size. Elastic's worst case
  is "every second page has a match", with CR 5.5 (HDD, rand/seq cost 10) and 3
  (SSD, ratio 2). The theoretical bounds are 11 and 6, "purely driven by the
  ratio between the random and sequential access". Empirical CR: 2.

Mapping:

- Smooth Scan grows its region with no binary switch because index-leaf reads
  are cheap next to heap pages. Ours are not. In W24's dense blocks postings
  mode reads about 2.08 rows per doc against docs mode's 1 (judge's
  pure-postings run, **(inferred)** from `/tmp/judge-r6-CRQJ/pure-post.txt`).
  Widening the docs walk does not remove the posting reads, so morphing cannot
  reach docs mode's cost.
- Two ideas carry over. Its bound is set by the random/sequential cost ratio.
  Ours is the range/row ratio, 32000/4096 = 7.8, near the paper's HDD case. And
  its Elastic policy measures selectivity only over regions it has actually
  read. Section 2.4 does the same with walked docs.

### 2.3 SQL Server adaptive joins, plan bouquets

[Microsoft Learn, "Joins", section "Adaptive joins"](https://learn.microsoft.com/en-us/sql/relational-databases/performance/joins?view=sql-server-ver17)
(doc updated 2026-10-19):

- The choice of hash join or nested loops is "deferred until after the first
  input has been scanned". If the build input has fewer rows than the threshold,
  the plan switches to nested loops. Otherwise it stays a hash join. The example
  threshold is 78 rows.
- The threshold is where the two estimated cost curves cross ("Adaptive
  threshold rows").
- On a switch "it uses the rows already read by the Hash Join build. The
  operator does not re-read the outer reference rows again."
- It decides once, after a blocking phase, and never switches back.

Mapping: our switch also keeps its work (the Cursor position). We need many
switches over one drain, and there is no blocking phase that exposes the count.
So the SQL Server threshold is our current rule's shape: one crossover and no
switch cost. It is fine for a single decision. It thrashes when the input
alternates.

Dutt, Haritsa, "Plan Bouquets: Query Processing without Selectivity Estimation",
SIGMOD 2014,
[PDF](https://dsl.cds.iisc.ac.in/publications/conference/bouquet.pdf), Section
3.1:

- Run plans under cost budgets in a geometric series with ratio `r`. Theorem 1:
  MSO `<= r²/(r-1)`, which is 4 at `r = 2`. Theorem 2: no deterministic online
  algorithm does better than 4 in 1D.
- Each budgeted run that fails is thrown away.

Mapping: our modes resume from the same position and lose nothing, so the MTS
model in 2.1 fits better than restart-with-doubling. Doubling is still the
textbook fix if we ever need trial runs of docs mode (section 5).

### 2.4 Posting intersection, seek cost, and counting docs passed

Veldhuizen, "Leapfrog Triejoin: A Simple, Worst-Case Optimal Join Algorithm",
ICDT 2014, [arXiv:1210.0481](https://arxiv.org/abs/1210.0481), Section 3.1:

- `seek(k)` positions at the least key `>= k` in `O(log N)`. Visiting `m` of `N`
  keys in order costs amortized `O(1 + log(N/m))`, "using standard data
  structures (notably, balanced trees such as B-trees)".
- Proposition 3.1: leapfrog join runs in `O(N_min log(N_max/N_min))`.

Demaine, López-Ortiz, Munro, "Adaptive set intersections, unions, and
differences", SODA 2000, pp. 743-752
([author page](https://erikdemaine.org/papers/SODA2000/)). The abstract claims
running times within a constant factor of optimal for the instance's difficulty.
I read only the abstract. Barbay, López-Ortiz, Lu,
[WEA 2006](https://www.cs.toronto.edu/~tl/papers/wea06.pdf), p. 4: the DLM
algorithm searches all other sets for an element with "one-sided binary search
or 'galloping' search". Bentley and Yao 1976 is the origin of galloping
([doi:10.1016/0020-0190(76)90071-5](<https://doi.org/10.1016/0020-0190(76)90071-5>)).
I could not download it. Their cost, about `2 log2 g` comparisons for a gap `g`,
is the commonly quoted figure, not one I read there.

Lucene at commit
[716d6f2](https://github.com/apache/lucene/tree/716d6f216f5216cbb6081d611c3e58d23e20de65):

- `Lucene104PostingsFormat.java` lines 60-63 and 116-121: skip data sits between
  every packed block of 256 docs, plus a second level every 32 blocks, and is
  "the skip interval used to accelerate advance". Lines 205-207: skip data
  stores "DocDelta", "how much the doc ID should be incremented in case the
  block gets skipped".

What this means for us **(inferred)**:

- A Convex index range costs 1 range whatever the gap. Walking costs one row per
  entry. So a seek over gap `g` with walk `w` costs `min(g, w)` rows, plus 1 to
  2 ranges when `g > w` (`SortedStream.seek`, `src/component/lib.ts` lines
  420-470). There is no log-cost middle ground. The walk is a ski rental: rent
  rows, buy a range. The break-even walk is `1 range / row load`, about 7.8 bare
  rows, and about 6 rows for 150-byte docs.
- Lucene doc IDs are dense ordinals. Docs passed over any skip is
  `target - current`, and skip data records the delta. Our sortKeys are not
  ordinals. Ties exist (W8 has 5000 tied sortKeys), and gaps in sortKey say
  nothing about doc counts. This is the root cause of round 6 F2 and F4.
- Convex has no count operator. "Convex has no built-in count operator ... use
  the `@convex-dev/aggregate` component (O(log n) reads)"
  (`example/convex/_generated/ai/guidelines.md` line 332;
  [aggregate README](https://github.com/get-convex/aggregate#readme) lines 15-17
  and 52). An aggregate keyed by `(namespace, sortKey, key)` would count docs
  passed exactly. It costs several reads per count and a write on every
  `set`/`remove`. I do not recommend it.

Docs passed, case by case:

| Stretch                                       | Docs passed                   | Why                                      |
| --------------------------------------------- | ----------------------------- | ---------------------------------------- |
| Docs stream walked to its target              | exact: rows walked            | each docs row is one doc, none skipped   |
| Docs stream walked `w` rows, then reopened    | unknown, `> w`                | no count, sortKey is no ordinal          |
| Walk cut short by `WALK_BYTES`, then reopened | unknown, `>= rows walked + 1` | only the bytes cap fired                 |
| First seek of a page (opens at the candidate) | unknown, `>= 1`               | the stream never saw the docs in between |
| Candidates examined                           | lower bound only              | candidate postings are a subset of docs  |
| Docs mode                                     | exact: one per row            | it reads every doc                       |

`skipped += walk` (lib.ts line 448) guesses the second row. W26 shows that guess
low by 8 times at gap 128 (`rounds.md`, round 6 F2). W32 shows it high on
byte-capped walks (F4). No guess can be right in both.

Jump bound **(inferred)**: on a row-capped jump, docs mode would read at least
`w + 1` docs (the walked ones and the target). Postings mode read those same
rows, plus at most 2 ranges and the posting rows `P` of that stretch. So
postings costs at most `docs + 2 + P` there, a ratio at most
`1 + (2 + P)/((w+1)·docRow)`. With `w = 8` and 150-byte docs (docRow about 0.165
L) the ratio is high, about 2.5 at `P = 1.5`. It applies only to gaps between 9
and roughly 30 docs. Above that, docs mode loses by more than the jump overhead.

### 2.5 Lucene: lead cost, conjunctions, two-phase iteration

Same Lucene commit.

- `IndexOrDocValuesQuery.java` lines 183-193:
  `threshold = cost() >>> 3; if (threshold <= leadCost) use index; else use doc values`.
  The comment: "we give an arbitrary 8x penalty to doc values". Lines 41-44 of
  the class doc: points when "we need a good lead iterator that will be almost
  entirely consumed", doc values "in the case that another part of the query is
  already leading iteration but we still need the ability to verify".
  `bulkScorer()` always uses the index (lines 196-200).
- `ScorerSupplier.java` lines 28-37: `leadCost` "can be interpreted as an upper
  bound of the number of times that nextDoc, advance and matches will be
  called".
- `DocIdSetIterator.java` lines 178-184: `cost()` is "generally an upper bound
  of the number of documents this iterator might match, but may be a rough
  heuristic".
- `ConjunctionDISI.java` lines 131-132: sort iterators by `cost()` "to allow the
  sparser iterator to lead". Lines 165-200 (`doNext`): when another iterator
  advances past the lead's doc, the lead advances to that doc
  (`doc = lead1.advance(next)`). This is leapfrog.
- `TwoPhaseIterator.java` lines 86-110: `approximation()` is "a superset of the
  matching documents", `matches()` confirms, `matchCost()` estimates the cost of
  one confirmation. Lines 354-355 sort two-phase sub-iterators by `matchCost`.

Mapping:

- Candidate stream is the lead, check grams are the other conjunction iterators,
  the doc read is `matches()`. Docs mode is a conjunction whose lead is "all
  docs" with one two-phase check.
- Lucene decides per segment, once, with a fixed factor of 8, from exact
  per-term doc counts (`cost()` of a postings iterator is its doc freq). We have
  no doc freqs. The probe estimates them by how far back its 32nd row lies (ADR
  0011, "Check Grams"). Lucene can avoid mid-query switching because its
  segment-level statistics are exact. That option is not open to us.
- Lucene never sits a check out. `advance` on skip data costs about a log of the
  gap, so walking on from behind is cheap. Ours costs a range, which is why ADR
  0011 makes checks sit out. That sitting out is what blocks entry in round 6
  F3.
- Side observation, outside this question: in Lucene a rejecting iterator moves
  the lead forward (`lead1.advance(next)`). Our candidate stream steps with
  `next()` after a check rejects. I did not measure whether leapfrogging the
  candidate stream saves rows.

### 2.6 Trigram and n-gram substring engines

Russ Cox,
["Regular Expression Matching with a Trigram Index"](https://swtch.com/~rsc/regexp/regexp4.html),
section "Indexed Regular Expression Search": the query is an AND/OR of trigrams,
and fewer than 3 characters yields ANY ("match all documents"). Candidates are
verified by running the regexp. Code at
[google/codesearch 74a12a9](https://github.com/google/codesearch/blob/74a12a911a79b901d1158c48d011b2da1b090fc9/index/read.go#L565-L578),
`index/read.go` lines 565-578: `QAll` returns every file id. `postingAnd` (lines
519-534) is a linear merge. There is no cost-based switch to scanning.

Zoekt at
[sourcegraph/zoekt c11c1cb](https://github.com/sourcegraph/zoekt/tree/c11c1cb52bdc4fde9a31a68ca9df182b3770cdd7):

- `index/indexdata.go` lines 338-360 and 417-462: look up every query ngram's
  exact frequency, return no match if any is 0, then iterate the two
  lowest-frequency, non-overlapping ngrams with a distance iterator.
- `index/matchtree.go` lines 1326-1333: patterns shorter than the ngram size go
  to a regexp tree that brute-forces. Lines 51-59 define evaluation cost tiers
  (`costConst` to `costRegexp`), the same role as Lucene's `matchCost`.

GitHub Blackbird,
["The technology behind GitHub's new code search"](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/),
sections "A search index primer", "Life of a query" and footnote 3: ngram
iterators are intersected and unioned lazily and read "only far enough to fetch
the requested number of results". Every document is still double checked.
Trigrams for common grams "aren't selective enough", which led to "sparse
grams", picked from a bigram weight function. The post describes no fallback to
scanning.

PostgreSQL:

- [pg_trgm docs F.35.4](https://www.postgresql.org/docs/current/pgtrgm.html#PGTRGM-INDEX):
  "a pattern with no extractable trigrams will degenerate to a full-index scan".
- `contrib/pg_trgm/trgm_regexp.c` lines 128-141 and 223-224 at
  [cab16d2](https://github.com/postgres/postgres/blob/cab16d214bc5b70dd3514c5631ffa1f0acb3fed3/contrib/pg_trgm/trgm_regexp.c#L128-L141):
  "we would like to know the distribution of trigrams, but we don't", so
  trigrams with padding blanks get penalties. Trigrams are dropped until the
  penalty is at most `WISH_TRGM_PENALTY = 16`, or fail past
  `MAX_TRGM_COUNT = 256`.
- `src/backend/access/gin/ginget.c` lines 517-535: entries are sorted by
  `predictNumberResult`. Rare ones go to the "required" set, frequent ones to
  "additional", whose items are skipped unless a required entry matches. This is
  our candidate gram and check grams.
- `src/backend/nodes/tidbitmap.c` lines 8-29: a bitmap goes "lossy" to one bit
  per page under memory pressure, and every tuple on the page is then rechecked.
  That is a morph driven by memory, not by cost. The planner picks a sequential
  or bitmap scan before execution from estimates. I did not cite planner code
  for that.

Mapping: none of these engines switch to a scan mid-query on cost. They pick
grams by frequency (exact in Zoekt, a penalty heuristic in pg_trgm, a weight in
Blackbird). They scan only when no gram can be extracted. Ours is the only
design here that runs a cost race between the index and the scan inside one
query, so the rule has to come from 2.1, not from these engines.

## 3. The recommended rule on the failures, by hand

Unit costs from the judge's pure-mode runs **(inferred)**. Each is
`rows·0.128 + bytes·4096/16 MiB` per doc, divided out of
`/tmp/judge-r6-CRQJ/pure-docs.txt` and `pure-post.txt`:

- W24 docs row: (6168·0.128 + 909568·0.000244)/6144 = 0.165 L.
- W24 postings per dense doc: (6380·0.128 + 933672·0.000244)/3072 = 0.34 L,
  about 2.08 rows. The checks hold every dense doc, so they are dropped after 64
  idle judgments.
- One switch: `s` is about 1 range in, 3 to 4 out.

All figures below are hand estimates, not measurements.

### F1 thrashing, W24 burst blocks (6144 docs, block 128)

Per dense doc postings mode exceeds docs mode by 0.34 - 0.165 = 0.175 L. Per
sparse doc docs mode exceeds postings by about 0.165 L. In the sparse block
postings mode jumps, which sets `b = -d`.

- `d = 4`: entering needs 8 L of excess, about 46 dense docs. Leaving needs 8 L,
  about 48 sparse docs. Per 256-doc cycle: 46·0.34 + 82·0.165 + 48·0.165
  - 1 + 5 ≈ 43 L. Over 24 cycles that is about 1030 L. Pure docs: 1037. The
    round 6 rule: 1343. Base: 1104.
- `d = 2`: about 23 and 24 docs. Per cycle about 35 L, 840 L total, -19% against
  pure docs.
- Block 112 (`d = 4`): about 40 L per 224-doc cycle, 1105 L. Base 1023, so about
  +8%. At `d = 2` about 885 L.

Thrash: it still switches twice per cycle, but each switch is paid for by at
least `2d` of excess. Short blocks whose excess stays under `2d` never switch.
That is the property round 6 lacked: its 128-doc window equalled the block, so
every judgment came one block late. Pick `d` by sweeping W24 at block 112
and 128. The bound allows +8% at block 112 with `d = 4`.

### F2 misjudged sparsity, W26 gap 128

Each 128 docs hold a cluster of 4 nominated docs (0 to 3), then 124 docs with
none of the grams. The docs stream walks docs 1 to 3 (exact: about 0.48 L of
excess each, 1.4 L per cluster), then walks 8 and reopens, a jump that sets
`b = -d`. `b` never gets from `-d` to `+d`. It stays in postings: about 197 L,
base 197. Round 6: 304.

Byte-capped walks (W32): with the jump floor on every reopen, W32 gap 2 would
stay in postings. That costs about 1 extra range per 2 docs, near the round 6
4869 against base 4393, +11%. So a walk cut short by `WALK_BYTES` must not floor
`b`. Add its exact lower bound instead (rows walked + 1 target on the docs
side). Then gap 2 is counted exactly and enters docs mode. At gap 9 the lower
bound is 2 docs against a true 9. It may enter wrongly about every 7 candidates
and leave after about 2 docs. I estimate +10 to 20% over pure postings there,
still far under base (3260).

### F3 blocked judgment, W28b N 512, budget 768

There is no settled gate, so a check that sits out blocks nothing. Docs 0 to 63
nominate every 32nd doc: jumps, `b = -d`. From doc 64 every doc is nominated and
walked. Postings reads about 2 rows (0.32 L) per doc against docs' 0.167, so `b`
climbs 0.155 per doc and enters at about doc 116 (`d = 4`). Estimate: about 10 L
for the first 64 docs, 52·0.32 = 17 L, 396·0.167 = 66 L, and about 7 ranges,
about 100 L in total. Base 101, round 6 168.5. At N 6144 the gain over round 6
should be the same 400-row prefix.

### Incident: 3650 `TR-26MMDD-NNN`, query `TR-260720-006`

Every probed gram is in every entry. Every entry is a candidate and passes the
checks, so the docs stream walks with gap 1 and every step is exact. Postings
reads 1 candidate posting, up to 3 check rows (until the idle drop at 64) and
the doc. That is about 0.5 to 0.7 L more than docs mode per doc. From `b = 0` it
enters docs mode within about 6 to 8 docs. In docs mode the postings estimate
stays at or above one doc row, since every doc holds every gram, so `b` stays at
`+d` and it never leaves. One switch, no misjudgment, no blocking. About
3650·0.18 ≈ 660 L, plus 1 range per page. That removes the 0.4.0 failure mode,
2057 ranges in one call.

## 4. What the implementation needs

State, carried in the Cursor:

- `d: 1` as now, plus `b` (a number in `[-d, d]`, rounded to 0.1). A new search
  starts at `b = 0`.
- Carry the plan `g` in docs mode too, so the per-doc postings estimate has
  grams to count. Today `d: 1` drops it (lib.ts lines 1084-1088).

Counters:

- Postings mode: `rowsRead`, `bytesRead` and ranges opened since the last
  docs-stream seek. `CallBudget` has the first two. Count ranges in L too: round
  6 left them out because a reopen hides docs, but under this rule the reopen is
  the jump case. Also count rows and bytes walked by that seek. And one flag per
  seek: reached by walking, cut by `WALK_BYTES`, or reopened after `w` rows.
- Docs mode, per doc: the row's load. The postings estimate for that doc is 1
  posting if it holds the candidate gram, plus 1 per check gram it holds. Count
  only checks that have rejected some doc in this stint, which mirrors the idle
  drop. If it would be nominated, add `min(gap, w)` doc rows and 1 range when
  `gap > w`. Use the posting load `postingLoad()` already computes.
- Page restarts: postings mode opens about `1 + checks` ranges per page, docs
  mode 1. A page ends after `budget` verifications. In the estimate, charge
  postings `(1 + checks)/budget` ranges per nominated doc and docs `1/budget`
  range per doc **(inferred)**. Without this, budget-1 drains misjudge (round 5
  F1, round 6 F8).
- `held` per sampled gram since entering docs mode, kept only so `leaveDocs` can
  replan. Drop the per-window reset.

Delete:

- `SortedStream.skipped` and `this.skipped += walk` (lines 399-403, 448), and
  `docsPassed()` (line 792).
- `mark()`/`since` (lines 793-798), `span` (803), `DENSE_AFTER`, `SPARSE_AFTER`,
  `SPARSE_AT_END` (lines 541-550).
- The settled gate `checks.every(... judged >= MISJUDGED_AFTER)` and its
  judgment (lines 1049-1063). `MISJUDGED_AFTER` stays for the swap.
- The end-of-call judgment (lines 1071-1079). With `b` carried, a page that ends
  mid-stretch keeps its evidence.
- `postingsCheaper()` as a window comparison (lines 845-862). It becomes the
  per-doc estimate above. `restartTally` per window goes too.
- The `narrowed` exception to idle drops was added to keep W22 entering docs
  mode. Under this rule W22 enters on measured excess, so it may be removable. I
  did not verify this.

What is left: one constant `d`, one clamped number, two switch conditions, one
per-seek update and one per-doc update.

## 5. Open questions and limits

- Not verified by running. All of section 3 is arithmetic on the judge's
  pure-mode totals. W24, W26, W28b, W32 and W19 need a bench run, with `d` in
  {2, 4, 8}.
- The blind regime. Gaps between `w + 1` and about 30 docs, with small docs,
  jump and floor `b`, so postings mode stays even where docs mode is up to about
  2.5 times cheaper (section 2.4). W19 `none` has `7-` in runs, so it is
  probably walked, not jumped. A judge workload with a uniform gap of 12 would
  expose this regime. Two fixes, neither verified: (a) estimate a jump's docs
  passed from the share of walked docs that hold the candidate gram, the Smooth
  Scan Elastic measure. That fails when candidates cluster next to long empty
  runs. (b) Spend-driven docs trials with doubling backoff (2.3), which bounds
  the waste by a log factor.
- The first seek of a page has no count. Under the rule it adds nothing, so in
  postings mode a budget-1 drain never builds `b` and never enters docs mode.
  The only fix I see is opening the docs stream at the Cursor and walking, which
  costs up to `w` doc rows per page in sparse regions.
- The docs-mode estimate of postings is still an estimate. The band bounds each
  error to `2d` per phase, but a consistent bias makes phases short. W1, which
  entered docs mode on checks that would have been dropped (+25% in round 5), is
  the case to recheck.
- The 3-competitive guarantee holds against the best switching schedule under
  exact costs. Our `c_P` in docs mode is estimated, and `c_D` on jumps is
  replaced by the floor. The bound then holds only on the stretches where both
  sides are exact. Elsewhere only the jump bound in 2.4 applies.
- I read neither the Smooth Scan VLDB J competitive analysis nor the original
  texts of Bentley-Yao, DLM or KMRS. Their claims here come from the ICDE
  summary, abstracts or later papers that cite them, and are marked where used.
