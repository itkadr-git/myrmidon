import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const report = (tasks) => buildReport({
  version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z",
  health: { status: "ok", version: "1.7.0" },
  tasks: tasks.map(([identifier, status]) => ({ identifier, status, title: "fixture" })),
});
const a = report([["OPE-1", "done"], ["OPE-2", "done"], ["OPE-3", "blocked"], ["OPE-4", "done"]]);
const b = report([["OPE-1", "blocked"], ["OPE-3", "done"], ["OPE-5", "done"], ["OPE-6", "done"]]);
const restored = report([["OPE-1", "done"], ["OPE-3", "done"], ["OPE-5", "done"], ["OPE-6", "done"]]);
const result = (status, added, removed, regressions, previous, current) => ({
  status, version: { before: "1.7.0", after: "1.7.0" }, added, removed, regressions,
  previous: { verified: previous }, current: { verified: current },
});

test("A to cloned A preserves the entire result", () => {
  assert.deepEqual(diffReports(a, structuredClone(a)), result("identical", [], [], [], false, false));
});

test("B to cloned B preserves the entire result", () => {
  assert.deepEqual(diffReports(b, structuredClone(b)), result("identical", [], [], [], false, false));
});

test("forward diff sorts additions and removals and detects deterioration", () => {
  assert.deepEqual(diffReports(a, b), result("changed", ["OPE-5", "OPE-6"], ["OPE-2", "OPE-4"], ["OPE-1"], false, false));
});

test("inverse diff swaps membership changes but reports the opposite regression", () => {
  assert.deepEqual(diffReports(b, a), result("changed", ["OPE-2", "OPE-4"], ["OPE-5", "OPE-6"], ["OPE-3"], false, false));
});

test("restoring a done task improves the aggregate without a regression", () => {
  assert.deepEqual(diffReports(b, restored), result("changed", [], [], [], false, true));
});

test("undoing the restoration is a regression and fails the aggregate", () => {
  assert.deepEqual(diffReports(restored, b), result("changed", [], [], ["OPE-1"], true, false));
});

test("composed A to restored snapshot retains membership changes but no regressions", () => {
  assert.deepEqual(diffReports(a, restored), result("changed", ["OPE-5", "OPE-6"], ["OPE-2", "OPE-4"], [], false, true));
});

test("restored snapshot to A detects the separately improved task as a regression", () => {
  assert.deepEqual(diffReports(restored, a), result("changed", ["OPE-2", "OPE-4"], ["OPE-5", "OPE-6"], ["OPE-3"], true, false));
});

test("CLI round trip emits the same exact directional JSON and exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-diff-roundtrip-"));
  try {
    const first = join(dir, "a.json");
    const second = join(dir, "b.json");
    writeFileSync(first, JSON.stringify(a));
    writeFileSync(second, JSON.stringify(b));
    const script = fileURLToPath(new URL("./diff.mjs", import.meta.url));
    for (const [paths, expected] of [
      [[first, second], result("changed", ["OPE-5", "OPE-6"], ["OPE-2", "OPE-4"], ["OPE-1"], false, false)],
      [[second, first], result("changed", ["OPE-2", "OPE-4"], ["OPE-5", "OPE-6"], ["OPE-3"], false, false)],
    ]) {
      const cli = spawnSync(process.execPath, [script, ...paths], { cwd: dir, encoding: "utf8" });
      assert.equal(cli.status, 1, cli.stderr);
      assert.deepEqual(JSON.parse(cli.stdout), expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
