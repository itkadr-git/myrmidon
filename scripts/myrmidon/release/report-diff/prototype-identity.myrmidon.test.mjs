import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const special = ["__proto__", "constructor", "toString", "hasOwnProperty"];
const task = (identifier, status = "done") => ({ identifier, title: "fixture", status });
function snapshot(tasks) {
  return JSON.parse(JSON.stringify(buildReport({
    version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z",
    health: { status: "ok", version: "1.7.0" }, tasks,
  })));
}
function expectDiff(before, after, expected) {
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  const result = diffReports(snapshot(before), snapshot(after));
  assert.deepEqual(result, expected);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototype);
}
const result = (added, removed, regressions, previous, current, status = "changed") => ({
  status, version: { before: "1.7.0", after: "1.7.0" }, added, removed, regressions,
  previous: { verified: previous }, current: { verified: current },
});

for (const id of special) {
  test(`adding ${id} is membership, not an inherited property`, () => {
    expectDiff([task("OPE-1")], [task("OPE-1"), task(id)], result([id], [], [], true, true));
  });
  test(`removing ${id} is membership, not an inherited property`, () => {
    expectDiff([task("OPE-1"), task(id)], [task("OPE-1")], result([], [id], [], true, true));
  });
  test(`regression for ${id} is not an addition or removal`, () => {
    expectDiff([task("OPE-1"), task(id)], [task("OPE-1"), task(id, "blocked")], result([], [], [id], true, false));
  });
}

test("all special IDs coexist and remain identical", () => {
  const tasks = [task("OPE-1"), ...special.map(id => task(id))];
  expectDiff(tasks, tasks, result([], [], [], true, true, "identical"));
});

test("mixed additions, removals and regressions stay independent", () => {
  expectDiff(
    [task("OPE-1"), task("__proto__"), task("constructor"), task("toString")],
    [task("OPE-1", "blocked"), task("__proto__", "blocked"), task("hasOwnProperty"), task("toString")],
    result(["hasOwnProperty"], ["constructor"], ["OPE-1", "__proto__"], true, false),
  );
});

test("CLI preserves special identifiers in its JSON diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-diff-identity-"));
  try {
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, JSON.stringify(snapshot([task("OPE-1"), task("constructor")])));
    writeFileSync(after, JSON.stringify(snapshot([task("OPE-1", "blocked"), task("__proto__")])));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./diff.mjs", import.meta.url)), before, after], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, "");
    assert.deepEqual(JSON.parse(run.stdout), result(["__proto__"], ["constructor"], ["OPE-1"], true, false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
