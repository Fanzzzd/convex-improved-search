# Bigrams with an end-of-text sentinel, not trigrams

Gram size is 2 because two-character queries are the dominant case for CJK
text ("停車", "過磅"), and a bigram index answers them with one point
lookup where a trigram index produces zero grams and degenerates to a full
scan — the pg_bigm-vs-pg_trgm tradeoff (pg_bigm's own comparison table:
1–2 character keywords are "Slow" on trigram, "Fast" on bigram; non-alphabetic
languages "Not supported" vs "Supported"). Latin text gets less selective
grams, which Verification (ADR-0001) absorbs as extra scan cost, not wrong
results.

The sentinel appended before gram extraction makes every character of an
Entry start exactly one gram, so single-codepoint queries are served by an
index on the gram's first codepoint — no separate unigram postings, and no
unfindable final character. A document genuinely containing the sentinel
codepoint (U+0001) can only create false candidates, which Verification
removes.

Rejected: trigram-only (SQLite FTS5's choice — falls back to full scans
below 3 chars, unaffordable under Convex read limits in a reactive query);
unigram+bigram double indexing (Lucene CJKBigramFilter `outputUnigrams` —
~2x postings for what the sentinel gives us free).
