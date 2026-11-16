import { describe, expect, it } from "vitest";
import { splitTextIntoPages } from "./document-parser-adapter.js";

describe("splitTextIntoPages boundary priority", () => {
  it.each([
    ["paragraph before later newline, sentence and space", "aaaa\n\nbb\ncc. dd eeFF", 16, ["aaaa\n\n", "bb\ncc. dd eeFF"]],
    ["newline before later sentence and space", "aaaa\nbb. cc dd eeFF", 14, ["aaaa\n", "bb. cc dd eeFF"]],
    ["sentence before later space", "aaaa. bb cc dd eeFF", 14, ["aaaa. ", "bb cc dd eeFF"]],
    ["last sentence punctuation", "aaaa. bb? cc! ddXX", 13, ["aaaa. bb? cc! ", "ddXX"]],
    ["space when no higher-priority separator exists", "aaaa bb cc ddEE", 10, ["aaaa bb cc ", "ddEE"]],
    ["hard cut for unbroken text", "abcdefghijklmnopqrstuvw", 8, ["abcdefgh", "ijklmnop", "qrstuvw"]],
    ["ignore separators before the minimum boundary", "a bcdefghijklmno", 10, ["a bcdefghi", "jklmno"]],
    ["Unicode survives cuts including a surrogate pair", "\u0410\u0411\ud83d\ude00\u754c\u00e9XYZ", 3, ["\u0410\u0411\ud83d", "\ude00\u754c\u00e9", "XYZ"]],
  ])("uses %s", (_name, text, maxChars, chunks) => {
    const pages = splitTextIntoPages(text, maxChars);
    expect(pages).toEqual(chunks.map((chunk, index) => ({ pageNumber: index + 1, text: chunk })));
    expect(pages.map((page) => page.text).join("")).toBe(text);
  });

  it("returns a single page for empty input and input exactly at the limit", () => {
    expect(splitTextIntoPages("", 8)).toEqual([{ pageNumber: 1, text: "" }]);
    expect(splitTextIntoPages("abcdefgh", 8)).toEqual([{ pageNumber: 1, text: "abcdefgh" }]);
  });
});
