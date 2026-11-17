import { describe, expect, it } from "vitest";
import { defaultSourceName, parseCorpusSourceUrl } from "./source-fetch.js";

describe("canonical names for URL documents", () => {
  it.each([
    ["https://docs.example.com", "text/html", "docs.example.com.html"],
    ["https://docs.example.com/", null, "docs.example.com"],
    ["https://docs.example.com/guide///", "text/html", "docs.example.com_guide.html"],
    ["https://docs.example.com/guide/other?token=secret#section", "text/html", "docs.example.com_guide_other.html"],
    ["https://docs.example.com/guide/start?token=secret#section", "application/xhtml+xml", "docs.example.com_guide_start.html"],
    ["https://docs.example.com/read.HTM", "text/html", "docs.example.com_read.HTM"],
    ["https://docs.example.com/read.Html", "application/xhtml+xml", "docs.example.com_read.Html"],
    ["https://docs.example.com/read.XHTML", "text/html", "docs.example.com_read.XHTML"],
    ["https://docs.example.com/guide/start", "text/plain", "docs.example.com_guide_start"],
    ["https://docs.example.com/report.pdf?download=1#page", "application/pdf", "docs.example.com_report.pdf"],
  ])("names %s with MIME %s as %s", (address, mime, expected) => {
    expect(defaultSourceName(new URL(address), mime)).toBe(expected);
  });

  it("limits the base to 200 characters before adding the HTML suffix", () => {
    const address = new URL(`https://example.com/${"a".repeat(210)}?secret=1#fragment`);
    const base = `example.com_${"a".repeat(188)}`;
    expect(defaultSourceName(address, "text/html")).toBe(`${base}.html`);
    expect(defaultSourceName(address, "text/plain")).toBe(base);
  });
});

describe("canonical source URLs", () => {
  it.each([
    [" HTTP://Example.COM:80/a?x=1&y=two#section ", "http://example.com/a?x=1&y=two"],
    ["https://Example.COM:443/a?x=1#part", "https://example.com/a?x=1"],
    ["http://Example.COM:443/a?x=1#part", "http://example.com:443/a?x=1"],
    ["https://Example.COM:80/a?x=1#part", "https://example.com:80/a?x=1"],
  ])("keeps the query and canonical port of %s, but removes its fragment", (input, expected) => {
    expect(parseCorpusSourceUrl(input).toString()).toBe(expected);
  });
});
