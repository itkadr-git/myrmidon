import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const script = fileURLToPath(new URL("./diff.mjs", import.meta.url));
const report = (tasks = [{ identifier: "OPE-1", title: "fixture", status: "done" }]) => buildReport({
  version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z",
  health: { status: "ok", version: "1.7.0" }, tasks,
});
const valid = (status, added = [], removed = [], regressions = [], current = true) => ({
  status, version: { before: "1.7.0", after: "1.7.0" }, added, removed, regressions,
  previous: { verified: true }, current: { verified: current },
});
const scenarios = [
  { name: "identical", before: report(), after: report(), expected: valid("identical"), exit: 0 },
  { name: "added task", before: report(), after: report([{ identifier: "OPE-1", title: "fixture", status: "done" }, { identifier: "OPE-2", title: "new", status: "done" }]), expected: valid("changed", ["OPE-2"]), exit: 1 },
  { name: "regressed task", before: report(), after: report([{ identifier: "OPE-1", title: "fixture", status: "blocked" }]), expected: valid("changed", [], [], ["OPE-1"], false), exit: 1 },
  { name: "removed task", before: report(), after: report([]), expected: valid("changed", [], ["OPE-1"], [], false), exit: 1 },
  { name: "task replacement", before: report(), after: report([{ identifier: "OPE-2", title: "new", status: "done" }]), expected: valid("changed", ["OPE-2"], ["OPE-1"]), exit: 1 },
  { name: "metadata change", before: report(), after: { ...report(), generatedAt: "2026-11-18T00:00:00Z" }, expected: valid("changed"), exit: 1 },
  { name: "failed health", before: report(), after: buildReport({ version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z", health: { status: "error", version: "1.7.0" }, tasks: [{ identifier: "OPE-1", title: "fixture", status: "done" }] }), expected: valid("changed", [], [], [], false), exit: 1 },
  { name: "invalid snapshot", before: report(), after: {}, expected: { status: "invalid", errors: ["current: incompatible report schema"] }, exit: 2 },
];

for (const scenario of scenarios) {
  for (const mode of ["absolute", "relative"]) {
    test(`${scenario.name}: ${mode} snapshot paths from two working directories`, () => {
      const root = mkdtempSync(path.join(tmpdir(), "myrmidon diff "));
      try {
        const files = path.join(root, "snapshots \u03a9");
        const cwds = [path.join(root, "cwd one"), path.join(root, "cwd \u4e8c")];
        for (const dir of [files, ...cwds]) mkdirSync(dir);
        const before = path.join(files, "before \u96ea.json");
        const after = path.join(files, "after \u96ea.json");
        writeFileSync(before, JSON.stringify(scenario.before));
        writeFileSync(after, JSON.stringify(scenario.after));
        assert.deepEqual(diffReports(scenario.before, scenario.after), scenario.expected);
        for (const cwd of cwds) {
          const paths = mode === "absolute" ? [before, after] : [path.relative(cwd, before), path.relative(cwd, after)];
          const child = spawnSync(process.execPath, [script, ...paths], { cwd, encoding: "utf8" });
          assert.equal(child.error, undefined);
          assert.equal(child.status, scenario.exit);
          assert.equal(child.stderr, "");
          assert.deepEqual(JSON.parse(child.stdout), scenario.expected);
          assert.deepEqual(JSON.parse(child.stdout), diffReports(scenario.before, scenario.after));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
