# 9. Multi-field entries via per-field verification

Date: 2026-08-14

## Status

Accepted

## Context

Real callers index composites: a receipt is a note plus a cargo
description plus a binding label. With a single text they must join with a
separator, and then (a) a query can falsely match across the seam, and
(b) "which part matched?" — which UIs want for highlighting — requires the
caller to re-derive the answer client-side by splitting and re-folding.

The obvious inverted-index answer (a field id inside every posting row)
would change the posting schema, grow the hot path, and complicate the
gram-diff update.

## Decision

An Entry is an ordered list of named Fields. The docs row stores
`fields: Record<string, string>` (folded per field); the posting rows are
**unchanged** — grams are extracted per field (each field gets its own
sentinel) and unioned into one posting set per Entry.

Correctness comes entirely from Verification, which was already per-candidate:
it now runs `folded.includes(query)` per field. A match therefore never
spans a field boundary, and the names of the matching fields — the
`matchedFields` of every hit — fall out for free.

Two wire-format consequences:

- `set` takes an **array** `[{ name, value }]`, not a record: Convex
  sorts record keys, and field order must be caller-controlled because
  the 4096-codepoint budget is spent in field order (the overflowing
  field is truncated, later fields dropped; `onOverflow: "error"` refuses
  instead). Duplicate names are refused.
- The client keeps the single-string sugar: `text: "…"` is one field
  named `text`.

## Consequences

- Postings schema, probe/stream search machinery, deferred reaping: all
  untouched. A field id never enters the index.
- `matchedFields` is exact, not approximate — it is the verifier's own
  answer, and the differential oracle checks it on every hit.
- Storage shape of the docs table changed (`foldedText` → `fields`), so
  0.1.x indexes must be re-backfilled (`set` is idempotent; re-run the
  ordinary backfill).
- A pathological caller could put thousands of fields in one Entry; the
  shared codepoint budget bounds total work regardless.
