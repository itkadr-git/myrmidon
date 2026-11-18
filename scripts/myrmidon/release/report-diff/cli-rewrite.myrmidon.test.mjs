import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const script = fileURLToPath(new URL("./diff.mjs", import.meta.url));
const task = (identifier, status = "done", title = "fixture") => ({ identifier, status, title });
function report(tasks = [task("OPE-1")], version = "1.7.0") {
  return buildReport({ version, label: "1.7", generatedAt: "2026-11-17T00:00:00Z", health: { status: "ok", version }, tasks });
}
const identical = {
  status: "identical", version: { before: "1.7.0", after: "1.7.0" },
  added: [], removed: [], regressions: [], previous: { verified: true }, current: { verified: true },
};
const changed = (overrides = {}) => ({ ...identical, status: "changed", ...overrides });
const cases = [
  ["added task", report([task("OPE-1"), task("OPE-2")]), changed({ added: ["OPE-2"] })],
  ["removed task", report([]), changed({ removed: ["OPE-1"], current: { verified: false } })],
  ["regressed task", report([task("OPE-1", "blocked")]), changed({ regressions: ["OPE-1"], current: { verified: false } })],
  ["replacement task", report([task("OPE-2")]), changed({ added: ["OPE-2"], removed: ["OPE-1"] })],
  ["version", report([task("OPE-1")], "1.7.1"), changed({ version: { before: "1.7.0", after: "1.7.1" } })],
  ["task title", report([task("OPE-1", "done", "revised")]), changed()],
  ["sorted additions", report([task("OPE-1"), task("OPE-3"), task("OPE-2")]), changed({ added: ["OPE-2", "OPE-3"] })],
  ["invalid schema", { verified: true, tasks: [] }, { status: "invalid", errors: ["current: incompatible report schema"] }],
];

for (const [name, replacement, expected] of cases) {
  test(`CLI rereads atomic replacement: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "report-diff-rewrite-"));
    try {
      const a = report();
      const previous = join(dir, "previous.json");
      const current = join(dir, "current.json");
      const staging = join(dir, "next.json");
      const original = JSON.stringify(a);
      writeFileSync(previous, original);
      writeFileSync(current, original);
      const check = (snapshot, result, code) => {
        assert.deepEqual(diffReports(a, snapshot), result);
        const cli = spawnSync(process.execPath, [script, previous, current], { cwd: dir, encoding: "utf8" });
        assert.ifError(cli.error);
        assert.equal(cli.status, code, cli.stderr);
        assert.equal(cli.stderr, "");
        assert.equal(cli.stdout, `${JSON.stringify(result, null, 2)}\n`);
        assert.deepEqual(JSON.parse(cli.stdout), result);
        assert.equal(readFileSync(previous, "utf8"), original);
        assert.equal(readFileSync(current, "utf8"), JSON.stringify(snapshot));
      };
      const replace = snapshot => {
        writeFileSync(staging, JSON.stringify(snapshot));
        renameSync(staging, current);
      };
      check(a, identical, 0);
      replace(replacement);
      check(replacement, expected, expected.status === "invalid" ? 2 : 1);
      replace(a);
      check(a, identical, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
