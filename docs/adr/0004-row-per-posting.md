# One row per Posting, never packed posting lists

Each (Namespace, Gram, Key) is its own row, with indexes on
`(namespace, gram, sortKey, key)` for the candidate stream,
`(namespace, key, gram)` for gram-diff updates / delete-by-Entry /
membership probes, and `(namespace, g1, sortKey, key)` for
single-codepoint queries. This is the layout the surviving prior art
converges on (FlexSearch's SQL/Mongo/ClickHouse adapters, Firestore
full-text-search's deterministic per-posting ids).

Rejected: one row per gram holding a packed array of keys
(fergies-inverted-index style). On Convex that makes every write a
read-modify-write of hot gram rows — an OCC conflict magnet on common CJK
bigrams — and common grams would grow toward the 1 MiB document limit.
FlexSearch's IndexedDB adapter is the cautionary tale: it packed rows for
store-specific reasons and paid with full-store scans on every delete.
