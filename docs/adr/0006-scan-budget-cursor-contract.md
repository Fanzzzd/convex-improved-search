# Pages may be empty while the search is not Done

`search` caps the candidates it checks against their documents per call (the
Scan Budget, sized against Convex's 4096-index-ranges-per-transaction limit;
since ADR-0011 it also stops at the transaction's headroom) and returns a Cursor
pointing at the last _scanned_ — not last _matched_ — posting. A selective
Filter over a common substring can therefore return a short or empty Page with a
non-null Cursor, and the caller must keep paging; `isDone` is the only
end-of-results signal. The alternatives are worse: scanning until the page fills
can blow the transaction's read limits, and silently stopping would drop matches
(the mistake this component exists to fix — clients that filter only what is
already loaded). This mirrors Convex's own sparse-pagination behavior where a
page can be empty while `status === "CanLoadMore"`.
