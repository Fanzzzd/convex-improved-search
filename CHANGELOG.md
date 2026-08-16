# Changelog

## [0.2.1](https://github.com/Fanzzzd/convex-improved-search/compare/v0.2.0...v0.2.1) (2026-08-16)


### Bug Fixes

* harden search bounds and release packaging ([536101c](https://github.com/Fanzzzd/convex-improved-search/commit/536101c02efb0161abdf7d683dd7ca65e68bd506))

## 0.2.0

- Multi-field entries: `text` accepts named fields; a match never spans a
  field boundary and every hit reports exact `matchedFields`
  (ADR 0009). **Breaking**: the component's docs-table shape changed —
  clear 0.1.x namespaces before upgrading, then re-run the backfill.
- `tableIndexer({ table, key?, map })`: one `(ctx, doc)` mapper (derived
  text welcome) drives `sync` / `syncDoc` / `syncMany` / `trigger()`
  (ADR 0010). **Breaking**: `SearchIndex.trigger(mapper)` removed;
  `ShardedSearchIndex.trigger` mappers now receive `(ctx, doc)`.
- Search sugar: `searchDocs` (hydrate hits from a table, drop dead keys),
  `searchPaginated` / `searchDocsPaginated` (Convex `paginationOpts`
  shape).
- Highlight utilities: `findFoldedRange` / `matchSegments` map folded
  matches back to original-text offsets (full-width, surrogate-safe).
- `get` returns `{ fields, sortKey, filters }` (**breaking**: was
  `foldedText`).

## 0.1.0

- Initial implementation: bigram inverted index with exact substring
  semantics (verify-always), CJK-first folding (NFKC + lowercase),
  exact-match filters, cursor pagination with scan budget, gram-diff
  updates, deferred posting reaping, time shards, triggers integration,
  clear/backfill recipes.
