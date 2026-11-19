import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function report(tasks) {
  return buildReport({ version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z",
    health: { status: "ok", version: "1.7.0" }, tasks });
}
const task = (identifier, status = "done") => ({ identifier, title: "fixture", status });
const expected = (status, added, removed, regressions, previous, current) => ({
  status, version: { before: "1.7.0", after: "1.7.0" }, added, removed, regressions,
  previous: { verified: previous }, current: { verified: current },
});
function fixtures() {
  const a = report([task("OPE-1"), task("OPE-2")]);
  const b = report([task("OPE-1"), task("OPE-3")]);
  b.tasks[0] = a.tasks[0];
  const c = report([task("OPE-1", "blocked"), task("OPE-3")]);
  c.tasks[1] = b.tasks[1];
  const snapshots = structuredClone([a, b, c]);
  return { a: freeze(a), b: freeze(b), c: freeze(c), snapshots };
}
const ab = expected("changed", ["OPE-3"], ["OPE-2"], [], true, true);
const bc = expected("changed", [], [], ["OPE-1"], true, false);
const aa = expected("identical", [], [], [], true, true);

test("shared tasks and nested frozen inputs survive alternating comparisons", () => {
  const { a, b, c, snapshots } = fixtures();
  assert.strictEqual(a.tasks[0], b.tasks[0]);
  assert.strictEqual(b.tasks[1], c.tasks[1]);
  const first = diffReports(a, b);
  assert.deepEqual(first, ab);
  assert.deepEqual(diffReports(b, c), bc);
  assert.deepEqual(diffReports(a, a), aa);
  assert.deepEqual(diffReports(a, b), first);
  assert.deepEqual([a, b, c], snapshots);
});

test("reverse shared comparison does not retain prior additions", () => {
  const { a, b, snapshots } = fixtures();
  diffReports(a, b);
  assert.deepEqual(diffReports(b, a), expected("changed", ["OPE-2"], ["OPE-3"], [], true, true));
  assert.deepEqual([a, b], snapshots.slice(0, 2));
});

test("mutating returned added array cannot poison later calls", () => {
  const { a, b, snapshots } = fixtures();
  diffReports(a, b).added.push("OPE-99");
  assert.deepEqual(diffReports(a, b), ab);
  assert.deepEqual([a, b], snapshots.slice(0, 2));
});

test("mutating returned removed array cannot poison later calls", () => {
  const { a, b, snapshots } = fixtures();
  diffReports(a, b).removed.splice(0);
  assert.deepEqual(diffReports(a, b), ab);
  assert.deepEqual([a, b], snapshots.slice(0, 2));
});

test("mutating returned regressions cannot poison later calls", () => {
  const { b, c, snapshots } = fixtures();
  diffReports(b, c).regressions[0] = "OPE-99";
  assert.deepEqual(diffReports(b, c), bc);
  assert.deepEqual([b, c], snapshots.slice(1));
});

test("mutating result metadata does not alias input or subsequent result", () => {
  const { a, b, snapshots } = fixtures();
  const result = diffReports(a, b);
  result.version.before = "corrupt"; result.previous.verified = false; result.current.verified = false;
  assert.deepEqual(diffReports(a, b), ab);
  assert.deepEqual([a, b], snapshots.slice(0, 2));
});

test("cloned snapshots compare identically after aliased calls", () => {
  const { a, b, c, snapshots } = fixtures();
  diffReports(a, b); diffReports(b, c);
  assert.deepEqual(diffReports(snapshots[0], snapshots[1]), ab);
  assert.deepEqual(diffReports(snapshots[0], a), aa);
  assert.deepEqual([a, b, c], snapshots);
});

test("CLI JSON agrees with independent expectations after shared input calls", () => {
  const { a, b, c, snapshots } = fixtures();
  diffReports(a, b); diffReports(b, c); diffReports(a, a);
  const dir = mkdtempSync(join(tmpdir(), "diff-aliases-"));
  try {
    const paths = snapshots.map((value, index) => {
      const path = join(dir, `${index}.json`); writeFileSync(path, JSON.stringify(value)); return path;
    });
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./diff.mjs", import.meta.url)), paths[0], paths[1]], { cwd: dir, encoding: "utf8" });
    assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.stdout), ab);
    assert.deepEqual(diffReports(a, b), ab);
    assert.deepEqual([a, b, c], snapshots);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
