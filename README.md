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
  `docs.filter((d) => fold(d.text).includes(fold(query)))` — the index only
  accelerates, it never approximates. Verified by a randomized differential
  test suite against a naive-scan oracle.
- **Any language.** Bigrams over folded codepoints — no tokenizer, no
  dictionary, no language configuration. A two-character Chinese query is a
  single index point-lookup.
- **Transactional.** Index updates run in the same mutation (the same
  transaction) as your own writes. With the
  [triggers](#option-b-triggers-zero-drift) integration there is no drift
  window, ever.
- **Reactive.** Search from a normal Convex query and results update live.
- **Unicode-sane.** NFKC + lowercase folding: full-width `ＡＢＣ１２３`
  matches `abc123`, decomposed and precomposed accents match each other,
  surrogate pairs are handled per-codepoint.

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

Define one `SearchIndex` per logical collection:

```ts
// convex/search.ts
import { SearchIndex } from "convex-improved-search";
import { components } from "./_generated/api";

export const notesSearch = new SearchIndex(components.improvedSearch, {
  name: "notes",
  // Typing-only: misspelled filter names in set/search become compile errors.
  filterFields: ["category"],
});
```

### Writing

Call `set`/`remove` in the same mutation as your own writes — atomically:

```ts
export const addNote = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const noteId = await ctx.db.insert("notes", { text: args.text, createdAt: Date.now() });
    await notesSearch.set(ctx, {
      key: noteId,
      text: args.text,
      sortKey: Date.now(), // results are ordered by sortKey descending
      filters: { category: "work" },
    });
    return noteId;
  },
});
```

`set` is an idempotent upsert, and edits pay only the gram *diff* — re-setting
a document with slightly changed text writes a handful of rows, not thousands.

### Searching

```ts
export const searchNotes = query({
  args: { query: v.string(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const { page, cursor, isDone } = await notesSearch.search(ctx, {
      query: args.query,           // "停車" — any substring, any language
      filters: { category: "work" }, // optional exact-match filters
      cursor: args.cursor,
      limit: 50,
    });
    // page: [{ key, sortKey }] newest-first — fetch your docs by key:
    const docs = await Promise.all(page.map(({ key }) => ctx.db.get("notes", key as Id<"notes">)));
    return { docs: docs.filter((d) => d !== null), cursor, isDone };
  },
});
```

> **Pagination contract:** a non-null `cursor` with a short — or even empty —
> `page` means the scan budget ran out before the page filled (e.g. a very
> selective filter over a common substring). Keep paging; matches keep
> arriving. Only `isDone: true` means the search is exhausted. If you render
> pages incrementally, auto-continue while the page is empty.

## Keeping the index in sync

### Option A: explicit calls

Shown above — call `set`/`remove` next to your own writes. Simple, no extra
dependencies, and atomic because it runs in the same mutation. The risk is a
forgotten call site; the `verify` recipe below is the backstop.

### Option B: triggers (zero drift)

With [`convex-helpers/server/triggers`](https://stack.convex.dev/triggers)
every write to a table syncs the index automatically, in the same transaction:

```ts
import { Triggers } from "convex-helpers/server/triggers";
import { customMutation, customCtx } from "convex-helpers/server/customFunctions";

const triggers = new Triggers<DataModel>();
triggers.register("notes", notesSearch.trigger((doc) => ({
  key: doc._id,
  text: doc.text,
  sortKey: doc.createdAt,
})));
// Return null from the mapper to keep a doc out of the index (e.g. archived rows).

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
```

Caveat (inherited from triggers itself): writes from the dashboard and
`npx convex import` bypass wrapped mutations. If you use those, run the
verify/backfill recipe afterwards.

### Backfilling existing data

Use [`@convex-dev/migrations`](https://www.convex.dev/components/migrations) —
`set` is idempotent, so the migration is safe to re-run:

```ts
export const backfillSearch = migrations.define({
  table: "notes",
  migrateOne: async (ctx, doc) => {
    await notesSearch.set(ctx, { key: doc._id, text: doc.text, sortKey: doc.createdAt });
  },
});
```

To verify (or repair) drift, walk your table the same way and compare
`fold(doc.text)` against `(await notesSearch.get(ctx, { key: doc._id }))?.foldedText`,
re-`set`ting rows that differ. To drop a whole namespace:

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

// Writes (or receipts.trigger(...) with the same mapper):
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

- Text is folded (`NFKC` + `toLowerCase`) and split into overlapping
  **bigrams of codepoints**, with an end-of-text sentinel so every character
  starts exactly one gram. One posting row per distinct gram.
- A query folds identically. Two-codepoint queries are one index point-lookup;
  longer queries stream the scarcest gram (chosen by probing) and reject
  candidates via point-lookups on the others; single-codepoint queries use a
  first-codepoint index. **Every candidate is then verified with
  `foldedText.includes(query)`** — the index is a pure candidate filter, so
  correctness never depends on the gram approximation (the same structural
  argument SQLite's FTS5 trigram tokenizer relies on).
- Design lineage: SQLite FTS5 trigram tokenizer (spec), pg_bigm (gram size 2
  for CJK), Lucene `TestNGramTokenizer` and SQLancer NoREC (differential
  testing methodology).

## Limits

- **Text**: up to **4096 codepoints** per document after folding. Longer text
  is truncated by default (substrings beyond the limit are unfindable);
  pass `onOverflow: "error"` to throw instead. The write path is engineered
  so a full-size document indexes within one Convex transaction — but avoid
  writing *several* max-size documents in a single mutation.
- **Deletes are lazy**: `remove` (and large shrinking edits) make the entry
  unfindable immediately, but posting cleanup beyond a small inline budget
  runs in a component-internal scheduled mutation moments later. Until it
  runs, leftover postings are only rejected candidates — never wrong
  results. (Convex counts deletes as reads, 4096/transaction, so a max-size
  document cannot be unindexed synchronously.)
- **Ordering**: `sortKey` descending only. Changing a doc's `sortKey`
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

## Development

```bash
npm install
npm run test        # 67 tests incl. randomized differential suite
npm run typecheck
npm run lint
```

A runnable demo lives in [example/](./example/) — a Vite + React app.

## License

Apache-2.0
