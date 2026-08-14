# NFKC + lowercase folding is part of the on-disk index format

Documents and queries are folded identically with `normalize("NFKC")` then
`toLowerCase()`. NFKC folds full-width forms (ＡＢＣ１２３ ↔ abc123 — what
Lucene's CJKWidthFilter exists for) and composes combining marks, so both
input forms of "ñ" match each other. Changing this function silently
invalidates every stored gram, so any future change must ship with a
reindex story.

Deliberate non-goals: diacritic stripping (é ≠ e; SQLite's
`remove_diacritics` behavior — could become an opt-in fold later) and
Simplified↔Traditional Han folding (台 ≠ 臺; NFKC does not do it, a
kVariant table could, as an opt-in). Folding never branches on script —
per-script tokenizers accumulate incomplete-codepoint-table bugs (e.g.
Quickwit's `chinese_compatible` misses kana and hangul entirely); a
script-blind fold structurally cannot.
