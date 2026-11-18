import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const A = ["OPE-01", "OPE-02", "OPE-03", "OPE-04", "OPE-05", "OPE-06", "OPE-07", "OPE-08"];
const B = ["OPE-09", "OPE-10", "OPE-11", "OPE-12", "OPE-13", "OPE-14", "OPE-15", "OPE-16"];
const tasks = ids => ids.map(identifier => ({ identifier, title: "fixture", status: "done" }));
function report(items) {
  return buildReport({ version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z", health: { status: "ok", version: "1.7.0" }, tasks: items });
}
function result(added, removed, regressions, previous, current, status = "changed") {
  return { status, version: { before: "1.7.0", after: "1.7.0" }, added, removed, regressions, previous: { verified: previous }, current: { verified: current } };
}
const unchanged = result([], [], [], true, true, "identical");
const cases = [
  { name: "unchanged islands", a: tasks(A), b: tasks(B), ea: unchanged, eb: unchanged, all: unchanged },
  { name: "one addition in each island", a: tasks([...A, "OPE-17"]), b: tasks([...B, "OPE-18"]), ea: result(["OPE-17"], [], [], true, true), eb: result(["OPE-18"], [], [], true, true), all: result(["OPE-17", "OPE-18"], [], [], true, true) },
  { name: "one removal in each island", a: tasks(A.slice(1)), b: tasks(B.slice(1)), ea: result([], ["OPE-01"], [], true, true), eb: result([], ["OPE-09"], [], true, true), all: result([], ["OPE-01", "OPE-09"], [], true, true) },
  { name: "regressions in both islands", a: tasks(A).map(t => t.identifier === "OPE-02" ? { ...t, status: "blocked" } : t), b: tasks(B).map(t => t.identifier === "OPE-10" ? { ...t, status: "blocked" } : t), ea: result([], [], ["OPE-02"], true, false), eb: result([], [], ["OPE-10"], true, false), all: result([], [], ["OPE-02", "OPE-10"], true, false) },
  { name: "passing A with failing B", a: tasks(A), b: tasks(B).map(t => t.identifier === "OPE-16" ? { ...t, status: "blocked" } : t), ea: unchanged, eb: result([], [], ["OPE-16"], true, false), all: result([], [], ["OPE-16"], true, false) },
  { name: "failing A with passing B", a: tasks(A).map(t => t.identifier === "OPE-08" ? { ...t, status: "blocked" } : t), b: tasks(B), ea: result([], [], ["OPE-08"], true, false), eb: unchanged, all: result([], [], ["OPE-08"], true, false) },
  { name: "addition and removal across islands", a: tasks([...A.slice(1), "OPE-18"]), b: tasks([...B.slice(1), "OPE-17"]), ea: result(["OPE-18"], ["OPE-01"], [], true, true), eb: result(["OPE-17"], ["OPE-09"], [], true, true), all: result(["OPE-17", "OPE-18"], ["OPE-01", "OPE-09"], [], true, true) },
  { name: "regression alongside removal and addition", a: tasks(A.slice(1)).map(t => t.identifier === "OPE-02" ? { ...t, status: "blocked" } : t), b: tasks([...B, "OPE-17"]), ea: result([], ["OPE-01"], ["OPE-02"], true, false), eb: result(["OPE-17"], [], [], true, true), all: result(["OPE-17"], ["OPE-01"], ["OPE-02"], true, false) },
];

for (const scenario of cases) {
  test(`disjoint composition: ${scenario.name}`, () => {
    const beforeA = report(tasks(A));
    const beforeB = report(tasks(B));
    const afterA = report(scenario.a);
    const afterB = report(scenario.b);
    const before = report([...tasks(A), ...tasks(B)]);
    const after = report([...scenario.a, ...scenario.b]);
    const a = diffReports(beforeA, afterA);
    const b = diffReports(beforeB, afterB);
    const combined = diffReports(before, after);
    assert.deepEqual(a, scenario.ea);
    assert.deepEqual(b, scenario.eb);
    assert.deepEqual(combined, scenario.all);
    assert.equal(combined.previous.verified, a.previous.verified && b.previous.verified);
    assert.equal(combined.current.verified, a.current.verified && b.current.verified);
  });
}

test("CLI exposes the fixed composition oracle as JSON", () => {
  const scenario = cases[7];
  const dir = mkdtempSync(join(tmpdir(), "myrmidon-composition-"));
  try {
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, JSON.stringify(report([...tasks(A), ...tasks(B)])));
    writeFileSync(after, JSON.stringify(report([...scenario.a, ...scenario.b])));
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./diff.mjs", import.meta.url)), before, after], { cwd: dir, encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.deepEqual(JSON.parse(cli.stdout), scenario.all);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
