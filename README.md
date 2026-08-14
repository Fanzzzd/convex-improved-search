# convex-improved-search

[![npm version](https://badge.fury.io/js/convex-improved-search.svg)](https://badge.fury.io/js/convex-improved-search)

**Transactional, reactive, exact substring search for Convex — built for the
languages the built-in search index can't handle.**

Convex's built-in [full text search](https://docs.convex.dev/search/text-search)
tokenizes on whitespace and punctuation and "works best with English or other
Latin-script languages". For Chinese, Japanese, Korean, Thai — or simply for
`LIKE '%…%'`-style substring matching in any language — it structurally cannot
help: a run of CJK text becomes a single token, and terms over 32 bytes
(≈11 CJK characters) are silently dropped from the index entirely.

This component fills that gap with a bigram inverted index that lives in
ordinary Convex tables:

- **Exact substring semantics.** The result set is provably identical to
  "some field of the document contains the query" (after folding) — the
  index only accelerates, it never approximates. Verified by a randomized
  differential test suite against a naive-scan oracle.
- **Any language.** Bigrams over folded codepoints — no tokenizer, no
  dictionary, no language configuration. A two-character Chinese query is a
  single index point-lookup.
- **Multi-field.** Index named fields (`note`, `cargo`, …); a match never
  spans a field boundary, and every hit reports `matchedFields` — which
  fields contained the query — for free.
- **Transactional.** One table, one mapper: `tableIndexer` keeps the index
  in the same transaction as your writes, with backfill and triggers driven
  by the same mapper. No drift window, ever.
- **Reactive.** Search from a normal Convex query and results update live.
- **Unicode-sane.** NFKC + lowercase folding: full-width `ＡＢＣ１２３`
  matches `abc123`, decomposed and precomposed accents match each other,
  surrogate pairs are handled per-codepoint. Exported highlight utilities
  map folded matches back to original-text offsets.

## Installation

```bash
npm install convex-improved-search
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import improvedSearch from "convex-improved-search/convex.config.js";

const app = defineApp();
app.use(improvedSearch);
export default app;
```

## Usage

One `SearchIndex` per logical collection, one `tableIndexer` binding it to
a table with one mapper:

```ts
// convex/search.ts
import { SearchIndex } from "convex-improved-search";
import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

export const notesSearch = new SearchIndex(components.improvedSearch, {
  name: "notes",
  // Typing-only: misspelled filter names in set/search become compile errors.
  filterFields: ["category"],
});

export const notesIndexer = notesSearch.tableIndexer<Doc<"notes">>({
  table: "notes",
  map: (ctx, note) =>
    note.archived
      ? null // null = keep this document out of the index
      : {
          text: { title: note.title, body: note.body }, // named fields (or one string)
          sortKey: note.createdAt, // results are ordered by sortKey descending
          filters: { category: note.category },
        },
});
```

The mapper receives a query ctx, so derived text is first-class — join in
related rows, aggregate, whatever; the index still updates atomically.

### Writing

Call `sync` after any write, in the same mutation — it reads the row and
upserts or removes the entry, hard deletes included:

```ts
export const addNote = mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const noteId = await ctx.db.insert("notes", { ...args, createdAt: Date.now() });
    await notesIndexer.sync(ctx, noteId); // same transaction — the index can never drift
    return noteId;
  },
});

export const deleteNote = mutation({
  args: { noteId: v.id("notes") },
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.noteId);
    await notesIndexer.sync(ctx, args.noteId); // missing row → entry removed
  },
});
```

Updates pay only the gram *diff* — re-syncing a document with slightly
changed text writes a handful of rows, not thousands. `syncMany(ctx, ids)`
covers writes that touch a batch of rows at once.

(You can also call `notesSearch.set` / `notesSearch.remove` directly — the
indexer is sugar over them, not a requirement.)

### Searching

`searchDocs` searches and hydrates from your table in one call:

```ts
export const searchNotes = query({
  args: { query: v.string(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const { page, cursor, isDone } = await notesSearch.searchDocs<Doc<"notes">>(ctx, {
      table: "notes",
      query: args.query, // "停車" — any substring, any language
      filters: { category: "work" }, // optional exact-match filters
      cursor: args.cursor,
      limit: 50,
    });
    // page: [{ doc, sortKey, matchedFields }] newest-first
    return { page, cursor, isDone };
  },
});
```

`matchedFields` names the fields whose text contained the query (for a
single-string entry it is `["text"]`) — exact, straight from the verifier.

Plain `search` returns `{ key, sortKey, matchedFields }` hits without
hydration, for keys that are not document ids. `searchPaginated` /
`searchDocsPaginated` speak Convex's standard `paginationOpts` /
`{ page, isDone, continueCursor }` shape for paginated-query clients.

> **Pagination contract:** a non-null `cursor` with a short — or even empty —
> `page` means the scan budget ran out before the page filled (e.g. a very
> selective filter over a common substring). Keep paging; matches keep
> arriving. Only `isDone: true` means the search is exhausted. If you render
> pages incrementally, auto-continue while the page is empty.

### Highlighting

The same folding the index uses, mapped back to original offsets — so a
half-width query highlights its full-width occurrence:

```tsx
import { matchSegments } from "convex-improved-search";

matchSegments("停車場月租 ＡＢＣ大樓", "abc");
// [{ text: "停車場月租 ", match: false }, { text: "ＡＢＣ", match: true }, { text: "大樓", match: false }]

// React:
{matchSegments(note.title, query).map((seg, i) =>
  seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
)}
```

`findFoldedRange(text, query)` returns the raw `[start, end)` UTF-16 range
(or `null` when the occurrence cannot be located — render unhighlighted).
Use `matchedFields` to decide *which* field to highlight.

## Keeping the index in sync

### Triggers (zero drift)

With [`convex-helpers/server/triggers`](https://stack.convex.dev/triggers)
every write to the table syncs automatically, driven by the same mapper:

```ts
import { Triggers } from "convex-helpers/server/triggers";
import { customMutation, customCtx } from "convex-helpers/server/customFunctions";

const triggers = new Triggers<DataModel>();
triggers.register("notes", notesIndexer.trigger());
export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
```

Caveat (inherited from triggers itself): writes from the dashboard and
`npx convex import` bypass wrapped mutations. If you use those, run the
backfill recipe afterwards.

### Backfilling existing data

Use [`@convex-dev/migrations`](https://www.convex.dev/components/migrations) —
`syncDoc` is idempotent and runs the same mapper as live writes, so the
migration doubles as a drift-repair reconcile:

```ts
export const backfillSearch = migrations.define({
  table: "notes",
  migrateOne: async (ctx, doc) => {
    await notesIndexer.syncDoc(ctx, doc);
  },
});
```

To inspect what the index believes about one key, `notesSearch.get(ctx,
{ key })` returns its folded `fields`, `sortKey` and `filters`. To drop a
whole namespace:

```ts
let cursor: string | null = null;
do { ({ cursor } = await notesSearch.clear(ctx, { cursor })); } while (cursor !== null);
```

### Scaling out: time shards

Past ~100k entries per namespace, partition by time with
`ShardedSearchIndex` — one namespace per shard (`receipts/2026Q3`), created
lazily on first write, pre-indexable ahead of a cutover with the ordinary
backfill recipe, droppable per shard via `clear`:

```ts
export const receipts = new ShardedSearchIndex(components.improvedSearch, {
  name: "receipts",
  filterFields: ["source"],
});
const shardOf = (createdAt: number) => {
  const d = new Date(createdAt);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

// Writes (or receipts.trigger((ctx, doc) => …) with the same shape):
await receipts.set(ctx, {
  key: doc._id, text: doc.note, sortKey: doc.createdAt,
  shard: shardOf(doc.createdAt),
});

// Reads: pass the live shard list, newest first.
const page = await receipts.search(ctx, {
  shards: ["2026Q3", "2026Q2", "2026Q1"],
  query: "停車",
});
```

The contract: derive the shard from the `sortKey`, so shard ranges are
disjoint and newest-first shard order makes concatenated results globally
sorted. Recent-first UIs get their answers from the first shard at a
fraction of the cost; paging naturally continues into older shards
(same cursor contract as `SearchIndex.search`).

## How it works

- Each field's text is folded (`NFKC` + `toLowerCase`) and split into
  overlapping **bigrams of codepoints**, with an end-of-text sentinel per
  field so every character starts exactly one gram and no gram spans a
  field boundary. One posting row per distinct gram of the entry.
- A query folds identically. Two-codepoint queries are one index point-lookup;
  longer queries stream the scarcest gram (chosen by probing) and reject
  candidates via point-lookups on the others; single-codepoint queries use a
  first-codepoint index. **Every candidate is then verified per field with
  `folded.includes(query)`** — the index is a pure candidate filter, so
  correctness never depends on the gram approximation (the same structural
  argument SQLite's FTS5 trigram tokenizer relies on), and `matchedFields`
  is the verifier's own answer.
- Design lineage: SQLite FTS5 trigram tokenizer (spec), pg_bigm (gram size 2
  for CJK), Lucene `TestNGramTokenizer` and SQLancer NoREC (differential
  testing methodology).

## Limits

- **Text**: up to **4096 codepoints** per entry after folding, shared
  across its fields in field order. Longer text is truncated by default
  (the overflowing field is cut, later fields dropped; substrings beyond
  the limit are unfindable); pass `onOverflow: "error"` to throw instead.
  The write path is engineered so a full-size entry indexes within one
  Convex transaction — but avoid writing *several* max-size entries in a
  single mutation.
- **Deletes are lazy**: `remove` (and large shrinking edits) make the entry
  unfindable immediately, but posting cleanup beyond a small inline budget
  runs in a component-internal scheduled mutation moments later. Until it
  runs, leftover postings are only rejected candidates — never wrong
  results. (Convex counts deletes as reads, 4096/transaction, so a max-size
  entry cannot be unindexed synchronously.)
- **Ordering**: `sortKey` descending only. Changing an entry's `sortKey`
  rewrites all its posting rows synchronously; a change touching more than
  3000 surviving grams is refused. Prefer stable sort keys (creation time).
- **Filters**: exact-match only, post-filtering. Highly selective filters
  over very common substrings consume scan budget — raise `budget` if needed.
- **Scale**: designed for up to ~100k documents per namespace. Storage is
  roughly one small row per character of indexed text. Beyond that,
  partition by time with `ShardedSearchIndex` (see above).
- **Traditional vs Simplified Chinese**: NFKC folds width and compatibility
  forms but does NOT map Simplified↔Traditional — `台` will not match `臺`.
  If you need that, pre-fold your text (and queries) with a kVariant table
  (e.g. the IRG kVariants data) before calling `set`/`search`; an opt-in
  fold option is on the roadmap.

## Upgrading from 0.1.x

- **Storage shape changed** (single folded text → named fields), and Convex
  validates existing rows against the component schema at push time — a
  deployment still holding 0.1.x index data will refuse the push. Clear
  every namespace on 0.1.x first (the `clear` loop above), then upgrade and
  re-run your backfill (`syncDoc`/`set` are idempotent).
- `SearchIndex.trigger(mapper)` is gone — bind a `tableIndexer({ table,
  map })` and use `indexer.trigger()`. The mapper now receives `(ctx, doc)`;
  so does `ShardedSearchIndex.trigger`'s.
- `get` returns `{ fields, sortKey, filters }` instead of `foldedText`.

## Development

```bash
npm install
npm run test        # 81 tests incl. randomized differential suite
npm run typecheck
npm run lint
```

A runnable demo lives in [example/](./example/) — a Vite + React app.

## License

Apache-2.0
