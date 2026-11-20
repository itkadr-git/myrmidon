import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectDirectTests, SHARED_GUARD_TESTS } from "./select.mjs";

const pkg = { name: "@myrmidon/server", dir: "server" };
const otherPkg = { name: "@fixture/other", dir: "fixture" };
const changedSource = "server/src/feature/widget.ts";
const changedTest = "server/src/tests/changed.test.ts";
const colocated = "server/src/feature/widget.test.ts";
const mock = "server/src/tests/mock.test.ts";
const typed = "server/src/tests/typed.test.ts";
const guard = SHARED_GUARD_TESTS[0];
const ordinary = "server/src/tests/ordinary.test.ts";
const test = (file, source = "") => ({ file, source });
const importWidget = 'import "../feature/widget.js";';
const fixtures = {
  changed: test(changedTest),
  colocated: test(colocated),
  mock: test(mock, 'vi.mock("../feature/widget.js");'),
  typed: test(typed, 'import type { Widget } from "../feature/widget.js";'),
  guard: test(guard),
  ordinary: test(ordinary, importWidget),
};

function selection(tests, limit, changed = [changedSource, changedTest], packages = [pkg]) {
  return selectDirectTests(changed, packages, tests, { limit, selective: [pkg.name, otherPkg.name] });
}

function expectPartition(result, kept, dropped) {
  assert.deepEqual(result, [{ package: pkg.name, total: kept.length + dropped.length, files: [...kept].sort(), dropped: [...dropped].sort() }]);
  const [{ total, files, dropped: excluded }] = result;
  assert.equal(total, files.length + excluded.length);
  assert.equal(new Set([...files, ...excluded]).size, total);
}

describe("direct selection ranking and partition", () => {
  for (const [name, higher, lower] of [
    ["changed beats co-located", "changed", "colocated"],
    ["co-located beats mock", "colocated", "mock"],
    ["mock beats type import", "mock", "typed"],
    ["type import beats shared guard", "typed", "guard"],
    ["shared guard beats ordinary import", "guard", "ordinary"],
  ]) {
    it(name, () => {
      expectPartition(selection([fixtures[lower], fixtures[higher]], 1), [fixtures[higher].file], [fixtures[lower].file]);
    });
  }

  it("keeps the top two ranks and drops the rest", () => {
    expectPartition(selection(Object.values(fixtures), 2), [changedTest, colocated], [mock, typed, guard, ordinary]);
  });

  it("keeps the top three ranks and drops the rest", () => {
    expectPartition(selection(Object.values(fixtures), 3), [changedTest, colocated, mock], [typed, guard, ordinary]);
  });

  it("prefers a named importer to an unrelated closer importer", () => {
    const named = "server/src/tests/widget-regression.test.ts";
    const near = "server/src/feature/aaa.test.ts";
    expectPartition(selection([test(near, 'import "./widget.js";'), test(named, importWidget)], 1), [named], [near]);
  });

  it("prefers a near importer to a lexically earlier distant importer", () => {
    const near = "server/src/feature/z-near.test.ts";
    const far = "server/src/tests/a-far.test.ts";
    expectPartition(selection([test(far, importWidget), test(near, 'import "./widget.js";')], 1), [near], [far]);
  });

  it("breaks equal rank and distance ties by path", () => {
    const a = "server/src/tests/a.test.ts";
    const z = "server/src/tests/z.test.ts";
    expectPartition(selection([test(z, importWidget), test(a, importWidget)], 1), [a], [z]);
  });

  it("returns the same partitions for shuffled packages and tests", () => {
    const original = selection(Object.values(fixtures), 3, [changedSource, changedTest], [pkg, otherPkg]);
    const shuffled = selection(Object.values(fixtures).reverse(), 3, [changedTest, changedSource], [otherPkg, pkg]);
    expectPartition(original, [changedTest, colocated, mock], [typed, guard, ordinary]);
    assert.deepEqual(shuffled, original);
  });

  it("counts a file selected for multiple reasons only once", () => {
    const multi = test(colocated, 'vi.mock("./widget.js"); import type { Widget } from "./widget.js";');
    expectPartition(selection([multi, multi, fixtures.ordinary], 1, [changedSource, colocated]), [colocated], [ordinary]);
  });

  it("drops all candidates at limit zero", () => {
    expectPartition(selection([fixtures.ordinary, fixtures.mock], 0), [], [mock, ordinary]);
  });

  it("keeps every candidate at the exact total", () => {
    expectPartition(selection([fixtures.ordinary, fixtures.mock], 2), [mock, ordinary], []);
  });

  it("does not select an unrelated test", () => {
    expectPartition(selection([fixtures.ordinary, test("server/src/tests/unrelated.test.ts", 'import "../feature/other.js";')], 1), [ordinary], []);
  });
});
