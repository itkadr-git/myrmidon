import assert from "node:assert/strict";
import { it } from "node:test";
import { formatFailures, formatSummary } from "./check-prod-runtime-resolution.mjs";

it("formats exact diagnostic rows inside and outside the working directory without mutation", () => {
  const rows = Object.freeze([
    Object.freeze({ file: "/fixture/work/server/dist/index.js", line: 12, specifier: "@myrmidon/missing", reason: "пакет не найден в node_modules", packageName: "@myrmidon/missing" }),
    Object.freeze({ file: "/fixture/other/helper.js", line: 3, specifier: "./source.ts", reason: "относительный импорт .ts", packageName: null }),
  ]);
  assert.deepEqual(formatFailures(rows, "/fixture/work"), [
    "server/dist/index.js:12 @myrmidon/missing → пакет не найден в node_modules",
    "/fixture/other/helper.js:3 ./source.ts → относительный импорт .ts",
  ]);
  assert.deepEqual(formatFailures(Object.freeze([]), "/fixture/work"), []);
  assert.equal(rows[0].file, "/fixture/work/server/dist/index.js");
});

it("uses the correct literal summary for each failure count", () => {
  const examples = [
    [0, "0 сбоев в 0 пакетах"],
    [1, "1 сбой в 1 пакете"],
    [2, "2 сбоя в 1 пакете"],
    [4, "4 сбоя в 1 пакете"],
    [5, "5 сбоев в 1 пакете"],
    [11, "11 сбоев в 1 пакете"],
    [21, "21 сбой в 1 пакете"],
    [22, "22 сбоя в 1 пакете"],
  ];
  for (const [count, expected] of examples) {
    const rows = Object.freeze(Array.from({ length: count }, () => Object.freeze({ packageName: "@myrmidon/a" })));
    assert.equal(formatSummary(rows), expected, `count ${count}`);
  }
});

it("counts distinct nonempty package names independently of failures", () => {
  const rows = Object.freeze([
    Object.freeze({ packageName: "@myrmidon/a" }),
    Object.freeze({ packageName: "@myrmidon/a" }),
    Object.freeze({ packageName: "@myrmidon/b" }),
    Object.freeze({ packageName: null }),
    Object.freeze({ packageName: "" }),
  ]);
  assert.equal(formatSummary(rows), "5 сбоев в 2 пакетах");
  assert.equal(formatSummary(Object.freeze([Object.freeze({ packageName: null })])), "1 сбой в 0 пакетах");
  assert.equal(formatSummary(Object.freeze([Object.freeze({ packageName: "@myrmidon/a" }), Object.freeze({ packageName: "@myrmidon/b" })])), "2 сбоя в 2 пакетах");
});
