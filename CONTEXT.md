# convex-improved-search

Transactional, reactive, exact substring search for Convex. One bounded
context: the component, its client SDK, and the vocabulary they share.

## Language

**Entry**:
One indexed unit: a key, its searchable text, a sort key, and optional
filters. What you pass to `set`.
_Avoid_: record, row, document (a Convex "document" is a storage concept)

**Key**:
The caller-chosen identifier of an Entry — typically the app document's
`_id`, but any string. The component never interprets it.
_Avoid_: id, docId

**Namespace**:
One logical collection of Entries, isolated from all others. One
`SearchIndex` instance addresses exactly one Namespace.
_Avoid_: index (overloaded), table, collection

**Folded Text**:
An Entry's text after Folding — the only form that is ever indexed or
compared.

**Folding**:
The normalization applied identically to Entry text and queries:
NFKC then lowercase. Part of the on-disk index format.
_Avoid_: normalization (too generic), tokenization (there is none)

**Gram**:
Two consecutive codepoints of Folded Text. The unit of the inverted index.
_Avoid_: token, term, ngram (gram size is fixed)

**Sentinel**:
The synthetic end-of-text codepoint appended before Gram extraction, so
every character of an Entry starts exactly one Gram.

**Posting**:
One stored (Namespace, Gram, Key, Sort Key) fact: "this Entry contains
this Gram".

**Verification**:
The final `foldedText.includes(foldedQuery)` check on every candidate.
Postings only nominate candidates; Verification decides. Correctness never
rests on Grams.
_Avoid_: recheck, filter (collides with Filters)

**Sort Key**:
The caller-supplied number that orders all results, descending. Typically
a creation timestamp.

**Filter**:
An exact-match constraint on an Entry's filter fields, applied during
Verification. An absent field matches nothing; `null` is a real value.
_Avoid_: facet, tag

**Scan Budget**:
The maximum number of candidates one `search` call may examine. Exhausting
it ends the call, never the search.

**Page**:
The result of one `search` call: matched keys plus a Cursor. A Page may be
short or empty while the search is not Done — that means the Scan Budget
ran out, not that matches ran out.

**Cursor**:
The resumption token covering everything already scanned. Feeding it back
continues the search exactly where it stopped.

**Done**:
The terminal search state (`isDone: true`): every Posting stream is
exhausted. The only signal that no further matches exist.

**Oracle**:
(test vocabulary) The naive full scan — `entries.filter(e =>
fold(e.text).includes(fold(query)))` — that `search` must equal exactly.
