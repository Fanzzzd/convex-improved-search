# Changelog

## [0.5.1](https://github.com/Fanzzzd/convex-improved-search/compare/v0.5.0...v0.5.1) (2026-10-31)


### Performance Improvements

* walk 2 docs before reopening at a candidate ([e604659](https://github.com/Fanzzzd/convex-improved-search/commit/e6046591e7e2e84336daec72dda5750a27df659e))

## [0.5.0](https://github.com/Fanzzzd/convex-improved-search/compare/v0.4.0...v0.5.0) (2026-10-30)


### Features

* dated shards for ShardedSearchIndex ([2a48685](https://github.com/Fanzzzd/convex-improved-search/commit/2a48685699386e2c83afbc8206e12a040b987ff5))
* field-tagged postings, exact (sortKey, key) seeks, verified count ([f8445db](https://github.com/Fanzzzd/convex-improved-search/commit/f8445db7106fce0c50d24a5f8a9d7866a583fd50))
* merge-joined check grams, transaction-aware scan budget, fields option for search ([a111b4b](https://github.com/Fanzzzd/convex-improved-search/commit/a111b4b5b9d87be91da490bfa2933ab00bdbde21))


### Bug Fixes

* bound dated shard discovery and reject duplicate shard lists ([c5217ec](https://github.com/Fanzzzd/convex-improved-search/commit/c5217ec9e0db30960adb8bc910ce2faadd5cccf0))
* check headroom before probing and accept inherited field names ([f83af64](https://github.com/Fanzzzd/convex-improved-search/commit/f83af6425ab0de18253270bdde680ecea56a9cb7))


### Performance Improvements

* bounded search cost per transaction; fields option; sorted-stream plan ([382aef4](https://github.com/Fanzzzd/convex-improved-search/commit/382aef49a287c74f2da2ca3f134ca0e21ec061b7))
* docs-only mode, check backoff and swap, plan in the cursor, bytes in one budget ([4c9bea6](https://github.com/Fanzzzd/convex-improved-search/commit/4c9bea684d26fcabe3ed4d4256be840913e2af31))
* judge both search modes by read load per doc passed ([6cea56e](https://github.com/Fanzzzd/convex-improved-search/commit/6cea56eff21eab4fc01d3cf76adb63112b2dfde2))
* one density rule for entering and leaving docs mode ([5620ccf](https://github.com/Fanzzzd/convex-improved-search/commit/5620ccfb6b9ce32b168be914b2f969080cd846cf))
* single-gram queries skip the probe; cursor resume walks 64 rows before an exact seek ([59e593d](https://github.com/Fanzzzd/convex-improved-search/commit/59e593d7fa1ad60df72d600290326e97ab2a9408))
* verify candidates by walking docs in step; check grams never reopen ([4ecd61d](https://github.com/Fanzzzd/convex-improved-search/commit/4ecd61d5df46424f5fc0ca48a602adc69bf0e558))

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
