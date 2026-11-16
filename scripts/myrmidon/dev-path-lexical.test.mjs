import test from "node:test";
import assert from "node:assert/strict";
import { shouldTrackDevServerPath } from "../dev-runner-paths.mjs";

const cases = [
  ["empty path", "", false],
  ["only dot slash", "./", false],
  ["double dot slash prefix", "././src/runtime.ts", true],
  ["backslash runtime path", "src\\runtime.ts", true],
  ["backslash test directory", "src\\__tests__\\runtime.ts", false],
  ["dot slash test directory", "./src/test/runtime.ts", false],
  ["dunder tests segment", "src/__tests__/runtime.js", false],
  ["underscore tests segment", "src/_tests/runtime.js", false],
  ["test segment", "src/test/runtime.js", false],
  ["tests segment", "src/tests/runtime.js", false],
  ["testing neighbor", "src/testing/worker.js", true],
  ["tests-old neighbor", "src/tests-old/worker.js", true],
  ["contest neighbor", "src/contest/worker.js", true],
  ["paperclip nested segment", "src/.paperclip/cache.js", false],
  ["paperclip backslash segment", "src\\.paperclip\\cache.js", false],
  ["paperclip-old neighbor", "src/.paperclip-old/cache.js", true],
  ["jest cjs config", "src/jest.config.cjs", false],
  ["jest js config", "src/jest.config.js", false],
  ["jest mjs config", "src/jest.config.mjs", false],
  ["jest ts config", "src/jest.config.ts", false],
  ["playwright config", "src/playwright.config.ts", false],
  ["vitest config", "src/vitest.config.ts", false],
  ["jest config neighbor", "src/jest.config.ts.old", true],
  ["playwright config neighbor", "src/playwright.config.js", true],
  ["vitest config neighbor", "src/vitest.config.mts", true],
  ["uppercase test extension", "src/worker.TEST.JS", false],
  ["mixed case spec extension", "src/worker.SpEc.Ts", false],
  ["bare test basename", "src/test.ts", true],
  ["test suffix without preceding dot", "src/mytest.ts", true],
  ["exact report", "src/report.20261116.102030.123.0.001.json", false],
  ["short report date", "src/report.2026111.102030.123.0.001.json", true],
  ["long report date", "src/report.202611160.102030.123.0.001.json", true],
  ["short report time", "src/report.20261116.10203.123.0.001.json", true],
  ["report missing component", "src/report.20261116.102030.123.0.json", true],
  ["report extra component", "src/report.20261116.102030.123.0.001.4.json", true],
];

for (const [name, path, expected] of cases) {
  test(name, () => {
    assert.strictEqual(shouldTrackDevServerPath(path), expected, path);
  });
}

test("alternating paths do not retain state", () => {
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(shouldTrackDevServerPath("src/.paperclip/cache.js"), false);
    assert.strictEqual(shouldTrackDevServerPath("src/.paperclip-old/cache.js"), true);
    assert.strictEqual(shouldTrackDevServerPath("src/tests/worker.js"), false);
    assert.strictEqual(shouldTrackDevServerPath("src/tests-old/worker.js"), true);
  }
});
