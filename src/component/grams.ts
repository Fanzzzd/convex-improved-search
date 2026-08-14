/**
 * Tokenization for exact substring search, modeled on SQLite FTS5's trigram
 * tokenizer (ext/fts5/fts5_tokenize.c) with two deliberate departures:
 *
 * - gram size is 2, not 3. Two-codepoint queries are the dominant case for
 *   CJK text ("停車", "過磅"), and a bigram index answers them with a single
 *   point lookup where a trigram index degenerates to a full scan (the
 *   pg_bigm-vs-pg_trgm tradeoff).
 * - the text is terminated with a sentinel codepoint, so every character of
 *   the document starts exactly one bigram. That gives single-codepoint
 *   queries an indexable form (all grams whose first codepoint matches) with
 *   no separate unigram postings.
 *
 * Like FTS5's trigram tokenizer there is NO padding at the start, NO word
 * splitting, and NO special-casing of punctuation or whitespace: every
 * codepoint participates, so any substring of the folded text is findable.
 * Documents and queries are folded identically.
 *
 * The index is only ever a candidate filter — search re-verifies every
 * candidate with `foldedText.includes(foldedQuery)` (the structural
 * correctness argument FTS5 encodes by leaving `omit` unset in xBestIndex).
 * Collisions with the sentinel (a document that genuinely contains U+0001)
 * can therefore only produce false candidates, never wrong results.
 */

/** End-of-text marker. May legitimately appear in user text; verification absorbs the collision. */
export const SENTINEL = "\u0001";

/** Hard cap on folded text length, in codepoints. See README: "Limits". */
export const MAX_TEXT_LENGTH = 4096;

/**
 * Fold document and query text into the form that is indexed and compared.
 * NFKC also folds full-width forms (ＡＢＣ１２３ → ABC123), which is what
 * Lucene's CJKWidthFilter exists for; toLowerCase is locale-insensitive.
 * Changing this function changes the on-disk index format — never change it
 * without a reindex story.
 */
export function fold(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

/** Codepoint-safe truncation (never splits a surrogate pair). */
export function truncateCodepoints(text: string, maxCodepoints: number): string {
	const codepoints = Array.from(text);
	if (codepoints.length <= maxCodepoints) return text;
	return codepoints.slice(0, maxCodepoints).join("");
}

/**
 * The deduplicated posting grams of a folded document.
 * `"abcd"` → `{"ab","bc","cd","d"}`; `"a"` → `{"a"}`; `""` → `{}`.
 */
export function documentGrams(foldedText: string): Set<string> {
	const codepoints = Array.from(foldedText);
	const grams = new Set<string>();
	for (let i = 0; i < codepoints.length; i++) {
		grams.add(codepoints[i] + (codepoints[i + 1] ?? SENTINEL));
	}
	return grams;
}

/**
 * The deduplicated grams a query must find in a candidate document.
 * No sentinel: a query is a substring, its end is not the document's end.
 * Queries of fewer than two codepoints return `[]` — the single-codepoint
 * case is served by the first-codepoint index instead.
 */
export function queryGrams(foldedQuery: string): string[] {
	const codepoints = Array.from(foldedQuery);
	const grams = new Set<string>();
	for (let i = 0; i + 1 < codepoints.length; i++) {
		grams.add(codepoints[i] + codepoints[i + 1]);
	}
	return [...grams];
}

/** First codepoint of a gram (codepoint-safe: never half a surrogate pair). */
export function firstCodepoint(gram: string): string {
	const first = gram.codePointAt(0);
	// Grams are never empty; guard for type narrowing only.
	return first === undefined ? "" : String.fromCodePoint(first);
}
