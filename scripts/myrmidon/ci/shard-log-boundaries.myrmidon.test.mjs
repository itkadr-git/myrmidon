import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSuiteCosts, mergeSuiteCosts, averageRuns, buildManifest } from "./shard-durations-from-logs.mjs";

const run = "2026-01-01T00:00:00.000Z  RUN v3";
const error = "no vitest suite completion lines found (wrong job log, or the reporter format changed)";
const parse = (...lines) => parseSuiteCosts([run, ...lines].join("\n"));

for (const [fraction, expected] of [["1", 100], ["123", 123], ["123456789", 123]]) {
  test(`timestamp fraction of ${fraction.length} digits`, () => {
    assert.deepEqual(parse(`2026-01-01T00:00:00.${fraction}Z  ✓ @myrmidon/server a.test.ts (1 test)`),
      [{ file: "server/a.test.ts", status: "✓", costMs: expected }]);
  });
}

test("ANSI escapes and CRLF are stripped", () => {
  const log = `${run}\r\n2026-01-01T00:00:01.000Z  \x1b[32m✓\x1b[0m @myrmidon/server a.test.ts (2 tests)\r\n`;
  assert.deepEqual(parseSuiteCosts(log), [{ file: "server/a.test.ts", status: "✓", costMs: 1000 }]);
});

test("singular and plural suites retain statuses and skipped and failed suffixes", () => {
  assert.deepEqual(parse(
    "2026-01-01T00:00:01.000Z  ✓ @myrmidon/server a.test.ts (1 test)",
    "2026-01-01T00:00:03.000Z  ↓ @myrmidon/server b.test.ts (3 tests | 2 skipped)",
    "2026-01-01T00:00:04.000Z  × @myrmidon/server c.test.ts (2 tests | 1 failed) 42ms",
  ), [
    { file: "server/a.test.ts", status: "✓", costMs: 1000 },
    { file: "server/b.test.ts", status: "↓", costMs: 2000 },
    { file: "server/c.test.ts", status: "×", costMs: 1000 },
  ]);
});

test("nested cases and other projects do not reset the completion clock", () => {
  assert.deepEqual(parse(
    "2026-01-01T00:00:01.000Z    ✓ nested case",
    "2026-01-01T00:00:02.000Z  ✓ @myrmidon/other other.test.ts (1 test)",
    "2026-01-01T00:00:03.000Z  ✓ @myrmidon/server real.test.ts (1 test)",
  ), [{ file: "server/real.test.ts", status: "✓", costMs: 3000 }]);
});

test("suite without RUN gives exact error", () => {
  assert.throws(() => parseSuiteCosts("2026-01-01T00:00:01.000Z  ✓ @myrmidon/server a.test.ts (1 test)"), { message: error });
});

test("RUN without suite gives exact error", () => {
  assert.throws(() => parseSuiteCosts(`${run}\n2026-01-01T00:00:01.000Z ordinary output`), { message: error });
});

test("custom project metacharacters are matched literally", () => {
  const log = [run,
    "2026-01-01T00:00:01.000Z  ✓ pkgXv1/a spec.test.ts (1 test)",
    "2026-01-01T00:00:02.000Z  ✓ pkg[v1]/a spec.test.ts (1 test)",
  ].join("\n");
  assert.deepEqual(parseSuiteCosts(log, { project: "pkg[v1]/a", pathPrefix: "custom/" }), [
    { file: "custom/spec.test.ts", status: "✓", costMs: 2000 },
  ]);
});

test("equal timestamps clamp to one millisecond", () => {
  assert.deepEqual(parse("2026-01-01T00:00:00.000Z  ✓ @myrmidon/server a.test.ts (1 test)"),
    [{ file: "server/a.test.ts", status: "✓", costMs: 1 }]);
});

test("backwards timestamps clamp to one millisecond", () => {
  assert.deepEqual(parse("2025-12-31T23:59:59.000Z  ✓ @myrmidon/server a.test.ts (1 test)"),
    [{ file: "server/a.test.ts", status: "✓", costMs: 1 }]);
});

test("duplicate suites across logs report the file", () => {
  const shard = parse("2026-01-01T00:00:01.000Z  ✓ @myrmidon/server a.test.ts (1 test)");
  assert.throws(() => mergeSuiteCosts([shard, shard]), { message: "suite appears in more than one log: server/a.test.ts" });
});

test("disjoint shards merge without mutation", () => {
  const shards = [parse("2026-01-01T00:00:01.000Z  ✓ @myrmidon/server a.test.ts (1 test)"),
    parse("2026-01-01T00:00:02.000Z  ✓ @myrmidon/server b.test.ts (1 test)")];
  const before = structuredClone(shards);
  assert.deepEqual(mergeSuiteCosts(shards), { "server/a.test.ts": 1000, "server/b.test.ts": 2000 });
  assert.deepEqual(shards, before);
});

test("sparse runs average only present values and round", () => {
  const runs = [{ a: 1, b: 10 }, { a: 2, c: 7 }, { b: 20 }];
  const before = structuredClone(runs);
  assert.deepEqual(averageRuns(runs), { a: 2, b: 15, c: 7 });
  assert.deepEqual(runs, before);
});

test("manifest sorts paths, preserves source, and does not mutate input", () => {
  const durations = { "server/z.test.ts": 9, "server/a.test.ts": 4 };
  const before = structuredClone(durations);
  const manifest = buildManifest(durations, "synthetic source");
  assert.deepEqual(Object.keys(manifest.durations), ["server/a.test.ts", "server/z.test.ts"]);
  assert.deepEqual(manifest.durations, { "server/a.test.ts": 4, "server/z.test.ts": 9 });
  assert.equal(manifest.$source, "synthetic source");
  assert.deepEqual(durations, before);
  assert.deepEqual(Object.keys(durations), ["server/z.test.ts", "server/a.test.ts"]);
});
