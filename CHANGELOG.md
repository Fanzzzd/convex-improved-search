# Changelog

## [0.4.0](https://github.com/Fanzzzd/convex-improved-search/compare/v0.3.0...v0.4.0) (2026-10-22)


### Features

* fill option for search/searchDocs; set skips the posting diff when text is unchanged ([#5](https://github.com/Fanzzzd/convex-improved-search/issues/5)) ([5af1c41](https://github.com/Fanzzzd/convex-improved-search/commit/5af1c41dfc517973a39095fdd909010b1a48d090)), closes [#4](https://github.com/Fanzzzd/convex-improved-search/issues/4)

## [0.3.0](https://github.com/Fanzzzd/convex-improved-search/compare/v0.2.1...v0.3.0) (2026-10-20)


### Features

* the trigger skips updates whose indexed entry is unchanged ([#2](https://github.com/Fanzzzd/convex-improved-search/issues/2)) ([7306392](https://github.com/Fanzzzd/convex-improved-search/commit/7306392287a25e31c3bc3a07fdcd0dbd33f96a36))

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
