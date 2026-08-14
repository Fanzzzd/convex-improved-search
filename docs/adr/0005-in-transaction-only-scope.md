# Scope boundary: in-transaction search only, external engines out

The component's core promise is that the index updates in the same Convex
transaction as the caller's writes (directly or via triggers) and that
queries are reactive. Anything that syncs data to an external engine
(Meilisearch, Typesense, Elasticsearch) has a fundamentally different
consistency model — asynchronous, stale-window, needs reconciliation — and
will never live in this component. If external-engine sync is ever wanted,
it is a sibling component with its own honest contract. Future growth
inside this component is limited to additional same-transaction retrieval
strategies (additive API).
