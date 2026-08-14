# 10. TableIndexer: one mapper, every sync path

Date: 2026-08-14

## Status

Accepted

## Context

0.1.x offered `set`/`remove` plus a `trigger(mapper)` helper. In practice
(the payable-system integration) an app accumulates several sync surfaces
for the same table: explicit calls at each write site, a migration for
backfill, sometimes a trigger. Each restates the same mapping from
document to Entry, and each restates the delete/archive handling — the
places they drift apart are exactly the places the index silently rots.

The trigger-only shape also could not express derived text (a receipt's
searchable cargo text comes from joined request rows), because the 0.1.x
mapper received only the document.

## Decision

`index.tableIndexer({ table, key?, map })` binds one table to one mapper
and derives every sync path from it:

- `sync(ctx, id)` — read the row, upsert or remove. A missing row (hard
  delete) or a `null` mapping removes; call it after any write, in the
  same mutation.
- `syncDoc(ctx, doc, id?)` — the same when the caller already holds the
  document (a migration's `migrateOne`).
- `syncMany(ctx, ids)` — fan-out after a write that touches many rows.
- `trigger()` — the convex-helpers triggers adapter, no second mapper.

The mapper is `(ctx, doc) => entry | null` and receives a query ctx, so
derived text (joins, counts) is first-class. `key` customizes the index
key (e.g. `driver:${id}` when several tables share a namespace).

`SearchIndex.trigger` is removed rather than kept as a second door: two
ways to express the mapping is how the drift starts.

## Consequences

- The mapping and the "when is this row out of the index" rule live in
  exactly one place; write sites shrink to `indexer.sync(ctx, id)`.
- Backfill and live writes provably agree — they run the same mapper.
- `sync` costs one extra `db.get` over hand-rolled `set` calls; in a
  Convex mutation that read is usually already cached, and correctness on
  hard deletes (where there is no row to map) requires the read-or-remove
  shape anyway.
- Breaking: 0.1.x `trigger((doc) => …)` call sites become
  `tableIndexer({ table, map: (ctx, doc) => … }).trigger()`; the sharded
  trigger mapper gains the ctx parameter for the same reason.
