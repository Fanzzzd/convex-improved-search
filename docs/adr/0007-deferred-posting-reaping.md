# Posting deletes are deferred; only sortKey rewrites are synchronous

Convex counts every delete and patch as a read toward its 4096-reads-per-
transaction limit, and `set`/`remove` share their transaction with the
caller (that is the whole point of trigger-based sync). A max-size document
owns ~4096 postings, so unindexing it synchronously is impossible — the
first e2e delete of a 4096-codepoint document proved it on a real
deployment (convex-test does not enforce this limit).

Verification makes the fix cheap: a stale posting is a false candidate that
costs one rejected check, never a wrong result. So `set` and `remove` delete
postings inline only up to a small budget and hand the tail to `reapKey`, a
self-rescheduling internal mutation that owns its own transaction and also
repairs duplicates and stale sortKeys (making it the reconcile primitive for
out-of-band writes such as dashboard edits). The docs row, which correctness
does rest on, is always written synchronously — a removed Entry is
unfindable the moment `remove` returns.

The one thing that cannot be deferred is a sortKey rewrite on surviving
grams: a stale sortKey moves a valid posting inside the candidate stream and
breaks page ordering and duplicate suppression. Those patches run inline,
and a sortKey change touching more surviving grams than the inline limit is
refused with a ConvexError. In practice: sort keys should be stable
(creation time), especially on multi-thousand-gram texts.
