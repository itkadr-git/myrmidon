import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanText, summarizeFindings } from "./scan-text.mjs";

const address = (...parts) => parts.join(".");
const assignment = [["pass", "word"].join(""), "fixture-value"].join("=");

describe("scanText line accounting", () => {
  it("returns no findings for clean LF text and a trailing newline", () => {
    assert.deepEqual(scanText(`plain\n${address(192, 0, 2, 1)}\n`), []);
  });

  it("returns no findings for clean CRLF text with blank lines", () => {
    assert.deepEqual(scanText(`\r\nplain\r\n${address(198, 51, 100, 1)}\r\n`), []);
  });

  it("numbers a first-line assignment from one", () => {
    assert.deepEqual(scanText(`${assignment}\nclean`), [
      { line: 1, rule: "secret-like assignment" },
    ]);
  });

  it("counts blank LF lines and a trailing newline", () => {
    assert.deepEqual(scanText(`clean\n\n${address(10, 1, 2, 3)}\n${assignment}\n`), [
      { line: 3, rule: "private address in 10/8" },
      { line: 4, rule: "secret-like assignment" },
    ]);
  });

  it("counts blank CRLF lines and a trailing newline", () => {
    assert.deepEqual(scanText(`\r\n${assignment}\r\n\r\n${address(172, 16, 2, 3)}\r\n`), [
      { line: 2, rule: "secret-like assignment" },
      { line: 4, rule: "private address in 172.16/12" },
    ]);
  });

  it("keeps all findings on a Unicode-prefixed line", () => {
    assert.deepEqual(scanText(`clean\n\u{1f30d} \u00e9 ${assignment} ${address(10, 1, 2, 3)} ${address(10, 1, 2, 4)}`), [
      { line: 2, rule: "secret-like assignment" },
      { line: 2, rule: "private address in 10/8" },
      { line: 2, rule: "private address in 10/8" },
    ]);
  });

  it("does not treat invalid or public addresses as findings alongside matches", () => {
    assert.deepEqual(scanText(`${address(10, 300, 1, 1)}\n${address(192, 0, 2, 1)}\n${address(192, 168, 1, 2)}`), [
      { line: 3, rule: "private address in 192.168/16" },
    ]);
  });
});

describe("summarizeFindings", () => {
  it("counts repeats in first-seen order without changing input", () => {
    const findings = [
      { line: 2, rule: "private address in 10/8" },
      { line: 3, rule: "secret-like assignment" },
      { line: 3, rule: "private address in 10/8" },
      { line: 4, rule: "secret-like assignment" },
      { line: 5, rule: "private address in 172.16/12" },
    ];
    const original = structuredClone(findings);
    assert.deepEqual(summarizeFindings(findings), [
      { rule: "private address in 10/8", count: 2 },
      { rule: "secret-like assignment", count: 2 },
      { rule: "private address in 172.16/12", count: 1 },
    ]);
    assert.deepEqual(findings, original);
  });

  it("returns an empty summary for empty findings", () => {
    assert.deepEqual(summarizeFindings([]), []);
  });
});
