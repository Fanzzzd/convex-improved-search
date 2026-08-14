# Exact substring semantics, with verification on every candidate

The product promise is exact substring search: results are provably equal to
a naive `fold(text).includes(fold(query))` scan, which lets a randomized
differential suite (oracle = the naive scan) prove correctness. To keep that
promise independent of the index, every candidate a gram lookup nominates is
re-verified against the stored folded text before it is returned — the same
structural argument SQLite's FTS5 makes by leaving `omit` unset for
LIKE/GLOB, so its trigram index is only ever a superset filter. Consequence:
every gram-selection heuristic (probe choice, budget, single-char path) is a
performance knob, never a correctness risk.

Rejected: relevance-ranked or fuzzy semantics. They would make the result
set judgment-based and untestable against an oracle, and they duplicate what
Convex's built-in search already does for Latin text.
