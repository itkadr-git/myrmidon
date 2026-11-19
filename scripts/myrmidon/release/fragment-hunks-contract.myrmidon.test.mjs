import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeHunks, parseHunks } from "./fragments-from-diff.mjs";

describe("fragment hunk contract", () => {
  it("parses omitted counts and zero-length insertion and deletion ranges", () => {
    const diff = [
      "@@ -3 +3 @@ heading", "-old", "+new",
      "@@ -0,0 +1,2 @@", "+first", "+second",
      "@@ -8,2 +9,0 @@", "-gone", "-also gone", "",
    ].join("\n");
    assert.deepEqual(parseHunks(diff), [
      { oldStart: 3, oldCount: 1, newStart: 3, newCount: 1, removed: ["old"], added: ["new"] },
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2, removed: [], added: ["first", "second"] },
      { oldStart: 8, oldCount: 2, newStart: 9, newCount: 0, removed: ["gone", "also gone"], added: [] },
    ]);
  });

  it("parses CRLF diff headers and preserves carriage returns in content", () => {
    const diff = "@@ -2 +2 @@ section\r\n-before\r\n+after\r\n";
    assert.deepEqual(parseHunks(diff), [
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, removed: ["before\r"], added: ["after\r"] },
    ]);
  });

  it("merges adjacent and blank-separated edits but not edits separated by content", () => {
    const hunks = parseHunks([
      "@@ -1 +1 @@", "-old one", "+one",
      "@@ -2 +2 @@", "-old two", "+two",
      "@@ -4 +4 @@", "-old three", "+three",
      "@@ -6 +6 @@", "-old four", "+four", "",
    ].join("\n"));
    const head = ["one", "two", " ", "three", "keep", "four"];
    const snapshot = structuredClone(hunks);
    const headSnapshot = [...head];
    const merged = mergeHunks(hunks, head);
    assert.deepEqual(merged, [
      { oldStart: 1, oldCount: 3, newStart: 1, newCount: 4, removed: ["old one", "old two", "old three"], added: ["one", "two", " ", "three"] },
      { oldStart: 6, oldCount: 1, newStart: 6, newCount: 1, removed: ["old four"], added: ["four"] },
    ]);
    assert.deepEqual(hunks, snapshot);
    assert.deepEqual(head, headSnapshot);
    merged[0].removed.push("mutation");
    merged[1].added.push("mutation");
    assert.deepEqual(hunks, snapshot);
  });

  it("retains zero ranges and independent arrays for separated insertion and deletion", () => {
    const hunks = parseHunks("@@ -0,0 +1 @@\n+inserted\n@@ -3 +3,0 @@\n-deleted\n");
    const snapshot = structuredClone(hunks);
    const head = ["inserted", "keep", "end"];
    const merged = mergeHunks(hunks, head);
    assert.deepEqual(merged, [
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, removed: [], added: ["inserted"] },
      { oldStart: 3, oldCount: 1, newStart: 3, newCount: 0, removed: ["deleted"], added: [] },
    ]);
    merged[0].added.push("mutation");
    merged[1].removed.push("mutation");
    assert.deepEqual(hunks, snapshot);
    assert.deepEqual(head, ["inserted", "keep", "end"]);
  });
});
