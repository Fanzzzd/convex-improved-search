/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
	SENTINEL,
	documentGrams,
	firstCodepoint,
	fold,
	queryGrams,
	truncateCodepoints,
} from "./grams.js";

// Tokenizer-output assertions in the spirit of SQLite's fts5trigram.test
// 12.0–12.2 (`sqlite3_fts5_tokenize db trigram "abcd"` → {abc bcd}, "a" → {},
// "" → {}), adapted to bigrams-with-end-sentinel.
describe("documentGrams", () => {
	test("sliding window with end sentinel", () => {
		expect(documentGrams("abcd")).toEqual(
			new Set(["ab", "bc", "cd", `d${SENTINEL}`]),
		);
	});
	test("single codepoint gets a sentinel gram", () => {
		expect(documentGrams("a")).toEqual(new Set([`a${SENTINEL}`]));
	});
	test("empty text has no grams", () => {
		expect(documentGrams("")).toEqual(new Set());
	});
	test("grams are deduplicated", () => {
		expect(documentGrams("aaaa")).toEqual(new Set(["aa", `a${SENTINEL}`]));
	});
	test("whitespace and punctuation participate like any codepoint", () => {
		expect(documentGrams("a b")).toEqual(
			new Set(["a ", " b", `b${SENTINEL}`]),
		);
	});
	test("surrogate pairs are single codepoints", () => {
		// 😀 is U+1F600 (two UTF-16 code units).
		const grams = documentGrams("a😀b");
		expect(grams).toEqual(new Set(["a😀", "😀b", `b${SENTINEL}`]));
	});
	test("CJK text grams", () => {
		expect(documentGrams("停車場")).toEqual(
			new Set(["停車", "車場", `場${SENTINEL}`]),
		);
	});
});

describe("queryGrams", () => {
	test("no sentinel on queries", () => {
		expect(queryGrams("abcd")).toEqual(["ab", "bc", "cd"]);
	});
	test("single codepoint yields nothing (g1 path)", () => {
		expect(queryGrams("a")).toEqual([]);
		expect(queryGrams("😀")).toEqual([]);
	});
	test("empty query yields nothing", () => {
		expect(queryGrams("")).toEqual([]);
	});
	test("deduplicated", () => {
		expect(queryGrams("aaa")).toEqual(["aa"]);
	});
});

describe("fold", () => {
	test("case folding", () => {
		expect(fold("AbCdEf")).toBe("abcdef");
	});
	test("full-width forms fold to ASCII (NFKC)", () => {
		expect(fold("ＡＢＣ１２３")).toBe("abc123");
	});
	test("combining marks compose (NFKC)", () => {
		// "a" + U+0303 combining tilde composes to precomposed U+00E3,
		// so both input forms match each other (fts5trigram2.test block 1's
		// concern, resolved by normalization instead of diacritic removal).
		expect(fold("a\u0303")).toBe("\u00e3");
		expect(fold("a\u0303")).toBe(fold("\u00e3"));
	});
	test("mathematical alphanumerics fold to plain letters", () => {
		// 𝒳 (U+1D4B3 MATHEMATICAL SCRIPT CAPITAL X) → X → x
		expect(fold("\u{1D4B3}")).toBe("x");
	});
	test("CJK text passes through", () => {
		expect(fold("停車場")).toBe("停車場");
	});
});

describe("firstCodepoint", () => {
	test("BMP", () => {
		expect(firstCodepoint("ab")).toBe("a");
	});
	test("surrogate pair", () => {
		expect(firstCodepoint("😀b")).toBe("😀");
	});
});

describe("truncateCodepoints", () => {
	test("no-op under the limit", () => {
		expect(truncateCodepoints("abc", 4)).toBe("abc");
	});
	test("never splits a surrogate pair", () => {
		expect(truncateCodepoints("a😀b", 2)).toBe("a😀");
	});
});
