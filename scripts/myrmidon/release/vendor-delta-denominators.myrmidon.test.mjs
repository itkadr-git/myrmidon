import assert from "node:assert/strict";
import test from "node:test";
import { formatShareLine } from "./vendor-share-notes.mjs";

const summary = (inherited, totalFiles) => Object.freeze({
  inherited,
  totalFiles,
  share: inherited / totalFiles,
});

const cases = [
  {
    name: "more inherited files but a smaller share as the repository grows",
    current: summary(60, 200), previous: summary(50, 100),
    expected: "Vendor-derived files: 60 of 200 (30.00%), \u0394 to myr-v1.6.4: -20.00 pp (+10 files)",
  },
  {
    name: "fewer inherited files but a larger share as the repository shrinks",
    current: summary(40, 50), previous: summary(50, 100),
    expected: "Vendor-derived files: 40 of 50 (80.00%), \u0394 to myr-v1.6.4: +30.00 pp (-10 files)",
  },
  {
    name: "equal shares at different sizes",
    current: summary(30, 120), previous: summary(20, 80),
    expected: "Vendor-derived files: 30 of 120 (25.00%), \u0394 to myr-v1.6.4: +0.00 pp (+10 files)",
  },
  {
    name: "zero to full share",
    current: summary(60, 60), previous: summary(0, 100),
    expected: "Vendor-derived files: 60 of 60 (100.00%), \u0394 to myr-v1.6.4: +100.00 pp (+60 files)",
  },
  {
    name: "full to zero share",
    current: summary(0, 120), previous: summary(100, 100),
    expected: "Vendor-derived files: 0 of 120 (0.00%), \u0394 to myr-v1.6.4: -100.00 pp (-100 files)",
  },
  {
    name: "round both the current percentage and a positive delta",
    current: summary(1, 3), previous: summary(1, 6),
    expected: "Vendor-derived files: 1 of 3 (33.33%), \u0394 to myr-v1.6.4: +16.67 pp (+0 files)",
  },
  {
    name: "round a negative delta independently of the file delta",
    current: summary(1, 6), previous: summary(1, 3),
    expected: "Vendor-derived files: 1 of 6 (16.67%), \u0394 to myr-v1.6.4: -16.67 pp (+0 files)",
  },
];

test("formatShareLine uses both denominators and preserves frozen inputs", async (t) => {
  for (const { name, current, previous, expected } of cases) {
    await t.test(name, () => {
      const currentBefore = structuredClone(current);
      const previousBefore = structuredClone(previous);
      assert.equal(formatShareLine(current, previous, "myr-v1.6.4"), expected);
      assert.equal(formatShareLine(current, previous, "myr-v1.6.4"), expected);
      assert.deepEqual(current, currentBefore);
      assert.deepEqual(previous, previousBefore);
    });
  }
});

test("formatShareLine distinguishes a missing tag from a missing prior summary", () => {
  const current = summary(1, 3);
  const previous = summary(1, 6);
  assert.equal(
    formatShareLine(current, previous),
    "Vendor-derived files: 1 of 3 (33.33%), \u0394 to the previous release: \u043d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445 (no previous release found)",
  );
  assert.equal(
    formatShareLine(current, null, "myr-v1.6.4"),
    "Vendor-derived files: 1 of 3 (33.33%), \u0394 to myr-v1.6.4: \u043d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445 (no vendor-share line in that release)",
  );
});
