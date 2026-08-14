# Time sharding is a client-side namespace convention

`ShardedSearchIndex` scales one logical collection past the comfortable
per-namespace size by giving each time shard (e.g. `receipts/2026Q3`) its
own Namespace. The component itself knows nothing about shards — a shard is
only a namespace-name convention — so shards appear lazily on first write,
can be pre-built with the ordinary backfill recipe before a cutover, and old
shards can be dropped with `clearNamespace`.

Search drains shards sequentially in caller order rather than merging
streams, because the time-shard contract (shard derived from the sortKey)
makes shard ranges disjoint: concatenation *is* the globally sorted order.
A k-way merge would only pay off for overlapping shards, which the contract
excludes — heterogeneous collections belong in one namespace with Filters
instead. The shard list is passed per call (it grows over time); the cursor
names its shard by string so list growth never invalidates it.

Rejected: component-level shard management (a shards table, fan-out inside
the component). It would recreate exactly the query fan-out the client can
do with `runQuery` per namespace, while hard-coding one partitioning policy.
