import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReport } from "../verify-on-prod.mjs";

const script = fileURLToPath(new URL("./diff.mjs", import.meta.url));
const task = (identifier, status = "done") => ({ identifier, title: "fixture", status });
function report(tasks = [task("OPE-1")], version = "1.7.0") {
  return buildReport({ version, label: "1.7", generatedAt: "2026-11-17T00:00:00Z", health: { status: "ok", version }, tasks });
}
function tree(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.join(prefix, entry.name);
    return entry.isDirectory() ? [[name, "directory"], ...tree(path.join(dir, entry.name), name)] : [[name, fs.readFileSync(path.join(dir, entry.name)).toString("hex")]];
  });
}
function expected(status, options = {}) {
  return { status, version: { before: "1.7.0", after: options.version ?? "1.7.0" }, added: options.added ?? [], removed: options.removed ?? [], regressions: options.regressions ?? [], previous: { verified: true }, current: { verified: options.verified ?? true } };
}
const cases = [
  ["identical snapshots", report(), report(), 0, expected("identical")],
  ["added task", report(), report([task("OPE-1"), task("OPE-2")]), 1, expected("changed", { added: ["OPE-2"] })],
  ["removed task", report([task("OPE-1"), task("OPE-2")]), report(), 1, expected("changed", { removed: ["OPE-2"] })],
  ["task regression", report(), report([task("OPE-1", "blocked")]), 1, expected("changed", { regressions: ["OPE-1"], verified: false })],
  ["version change", report(), report([task("OPE-1")], "1.7.1"), 1, expected("changed", { version: "1.7.1" })],
  ["empty task list", report(), report([]), 1, expected("changed", { removed: ["OPE-1"], verified: false })],
  ["invalid previous snapshot", {}, report(), 2, { status: "invalid", errors: ["previous: incompatible report schema"] }],
  ["invalid current snapshot", report(), {}, 2, { status: "invalid", errors: ["current: incompatible report schema"] }],
];

function sandbox(t, before, after) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "diff-readonly-"));
  const inputs = path.join(dir, "inputs");
  fs.mkdirSync(inputs);
  fs.writeFileSync(path.join(inputs, "before.json"), JSON.stringify(before));
  fs.writeFileSync(path.join(inputs, "after.json"), JSON.stringify(after));
  fs.writeFileSync(path.join(dir, "sentinel"), "sentinel\0bytes\n");
  for (const file of ["before.json", "after.json"]) fs.chmodSync(path.join(inputs, file), 0o444);
  fs.chmodSync(path.join(dir, "sentinel"), 0o444);
  const snapshot = tree(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, snapshot };
}
for (const [name, before, after, exit, result] of cases) {
  test(`CLI is read-only: ${name}`, t => {
    const { dir, snapshot } = sandbox(t, before, after);
    const child = spawnSync(process.execPath, [script, "inputs/before.json", "inputs/after.json"], { cwd: dir, encoding: "utf8" });
    assert.equal(child.error, undefined);
    assert.equal(child.status, exit);
    assert.equal(child.stderr, "");
    assert.deepEqual(JSON.parse(child.stdout), result);
    assert.deepEqual(tree(dir), snapshot);
  });
}
test("import has no output or filesystem effects", t => {
  const { dir, snapshot } = sandbox(t, report(), report());
  const child = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(script).href)})`], { cwd: dir, encoding: "utf8" });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  assert.deepEqual(tree(dir), snapshot);
});
