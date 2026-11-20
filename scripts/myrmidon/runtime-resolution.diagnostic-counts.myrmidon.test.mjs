import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { formatFailures, formatSummary } from "./check-prod-runtime-resolution.mjs";

describe("diagnostic counts", () => {
  const cases = [
    [0, "0 сбоев в 0 пакетах"],
    [1, "1 сбой в 1 пакете"],
    [2, "2 сбоя в 2 пакетах"],
    [4, "4 сбоя в 4 пакетах"],
    [5, "5 сбоев в 5 пакетах"],
    [11, "11 сбоев в 11 пакетах"],
    [21, "21 сбой в 21 пакете"],
    [22, "22 сбоя в 22 пакетах"],
    [25, "25 сбоев в 25 пакетах"],
    [111, "111 сбоев в 111 пакетах"],
  ];

  for (const [count, expected] of cases) {
    it(`formats ${count} failures and unique packages`, () => {
      const rows = Array.from({ length: count }, (_, i) => ({ packageName: `pkg-${i}` }));
      assert.equal(formatSummary(rows), expected);
    });
  }

  it("counts distinct package names separately and excludes null", () => {
    const rows = [
      { packageName: "@myrmidon/a" },
      { packageName: null },
      { packageName: "@myrmidon/a" },
      { packageName: "@myrmidon/b" },
      { packageName: null },
    ];
    assert.equal(formatSummary(rows), "5 сбоев в 2 пакетах");
    assert.equal(formatSummary([{ packageName: null }]), "1 сбой в 0 пакетах");
  });
});

describe("failure formatting", () => {
  it("preserves order and fields, with internal relative and external absolute paths", () => {
    const cwd = path.resolve("/fixture/project");
    const rows = [
      { file: path.join(cwd, "server/dist/z.js"), line: 12, specifier: "./bad.ts", reason: "относительный импорт .ts", packageName: null },
      { file: path.resolve("/fixture/other/a.js"), line: 3, specifier: "@myrmidon/missing", reason: "пакет не найден", packageName: "@myrmidon/missing" },
      { file: path.join(cwd, "..hidden/file.js"), line: 1, specifier: "./x.ts", reason: "не найден", packageName: null },
    ];
    const before = structuredClone(rows);
    const expected = [
      "server/dist/z.js:12 ./bad.ts → относительный импорт .ts",
      "/fixture/other/a.js:3 @myrmidon/missing → пакет не найден",
      "..hidden/file.js:1 ./x.ts → не найден",
    ];
    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual(formatFailures(rows, cwd), expected);
      assert.equal(formatSummary(rows), "3 сбоя в 1 пакете");
      assert.deepEqual(rows, before);
    }
  });
});
