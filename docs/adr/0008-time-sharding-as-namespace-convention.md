# Time sharding is a client-side namespace convention

`ShardedSearchIndex` scales one logical collection past the comfortable
per-namespace size by giving each time shard (e.g. `receipts/2026Q3`) its own
Namespace. The component itself knows nothing about shards — a shard is only a
namespace-name convention — so shards appear lazily on first write, can be
pre-built with the ordinary backfill recipe before a cutover, and old shards can
be dropped with `clearNamespace`.

Search drains shards sequentially in caller order rather than merging streams,
because the time-shard contract (shard derived from the sortKey) makes shard
ranges disjoint: concatenation _is_ the globally sorted order. A k-way merge
would only pay off for overlapping shards, which the contract excludes —
heterogeneous collections belong in one namespace with Filters instead. The
shard list is passed per call (it grows over time); the cursor names its shard
by string so list growth never invalidates it.

A `period` (month, quarter, year in UTC) derives the shard from the sortKey, so
a caller cannot put an Entry in the wrong shard, and the shard names sort as
their periods do. Search then needs no shard list: the component's
`namespaceBefore` returns the greatest namespace below a given one that starts
with `${name}/` and holds a doc, in one range over `docs.by_ns_sort`. Empty
periods are skipped at no cost, and the component still knows nothing about
shards: it lists namespaces by prefix.

Rejected: component-level shard management (a shards table, fan-out inside the
component). It would recreate exactly the query fan-out the client can do with
`runQuery` per namespace, while hard-coding one partitioning policy.
