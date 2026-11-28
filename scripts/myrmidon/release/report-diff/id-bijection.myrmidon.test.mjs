import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const mapping = {
  "OPE-1": "NEW-12", "OPE-2": "NEW-3", "OPE-3": "NEW-10",
  "OPE-4": "NEW-1", "OPE-5": "NEW-8", "OPE-6": "NEW-2",
  "OPE-7": "NEW-11", "OPE-8": "NEW-4", "OPE-9": "NEW-9",
  "OPE-10": "NEW-5", "OPE-11": "NEW-7", "OPE-12": "NEW-6",
};
const inverse = Object.fromEntries(Object.entries(mapping).map(([a, b]) => [b, a]));
const beforeTasks = [
  ["OPE-1", "done"], ["OPE-2", "done"], ["OPE-3", "done"],
  ["OPE-4", "done"], ["OPE-5", "blocked"], ["OPE-6", "done"],
  ["OPE-7", "blocked"], ["OPE-8", "done"], ["OPE-9", "done"],
  ["OPE-10", "done"],
];
const afterTasks = [
  ["OPE-1", "blocked"], ["OPE-2", "blocked"], ["OPE-3", "done"],
  ["OPE-4", "done"], ["OPE-5", "blocked"], ["OPE-6", "done"],
  ["OPE-7", "done"], ["OPE-8", "done"], ["OPE-11", "done"],
  ["OPE-12", "blocked"],
];
function report(entries) {
  return buildReport({ version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z",
    health: { status: "ok", version: "1.7.0" },
    tasks: entries.map(([identifier, status]) => ({ identifier, status, title: "fixture" })) });
}
function rename(input, map) {
  const copy = structuredClone(input);
  for (const task of copy.tasks) task.identifier = map[task.identifier];
  return copy;
}
const expected = {
  status: "changed", version: { before: "1.7.0", after: "1.7.0" },
  added: ["OPE-11", "OPE-12"], removed: ["OPE-10", "OPE-9"],
  regressions: ["OPE-1", "OPE-2"], previous: { verified: false }, current: { verified: false },
};
const renamedExpected = {
  status: "changed", version: { before: "1.7.0", after: "1.7.0" },
  added: ["NEW-6", "NEW-7"], removed: ["NEW-5", "NEW-9"],
  regressions: ["NEW-12", "NEW-3"], previous: { verified: false }, current: { verified: false },
};
function fixture() {
  const before = report(beforeTasks); const after = report(afterTasks);
  return { before, after, renamedBefore: rename(before, mapping), renamedAfter: rename(after, mapping) };
}

test("fixed mapping is a bijection over twelve IDs", () => {
  assert.equal(Object.keys(mapping).length, 12);
  assert.equal(new Set(Object.values(mapping)).size, 12);
  assert.equal(Object.keys(inverse).length, 12);
});
test("original reports classify exact IDs", () => {
  const { before, after } = fixture();
  assert.deepEqual(diffReports(before, after), expected);
});
test("renamed reports classify exact IDs with lexical sorting", () => {
  const { renamedBefore, renamedAfter } = fixture();
  assert.deepEqual(diffReports(renamedBefore, renamedAfter), renamedExpected);
});
test("inverse rename restores reports and classification", () => {
  const { before, after, renamedBefore, renamedAfter } = fixture();
  const restoredBefore = rename(renamedBefore, inverse); const restoredAfter = rename(renamedAfter, inverse);
  assert.deepEqual(restoredBefore, before); assert.deepEqual(restoredAfter, after);
  assert.deepEqual(diffReports(restoredBefore, restoredAfter), expected);
});
test("comparison does not mutate either original or renamed input", () => {
  const inputs = fixture(); const snapshot = structuredClone(inputs);
  diffReports(inputs.before, inputs.after); diffReports(inputs.renamedBefore, inputs.renamedAfter);
  assert.deepEqual(inputs, snapshot);
});
test("PASS aggregate remains PASS for identical reports after rename", () => {
  const pass = report([["OPE-3", "done"], ["OPE-4", "done"]]);
  const renamed = rename(pass, mapping);
  for (const value of [pass, renamed]) assert.deepEqual(diffReports(value, structuredClone(value)), {
    status: "identical", version: { before: "1.7.0", after: "1.7.0" }, added: [], removed: [], regressions: [],
    previous: { verified: true }, current: { verified: true },
  });
});
test("aggregate PASS to FAIL is preserved by rename", () => {
  const pass = report([["OPE-1", "done"], ["OPE-3", "done"]]);
  const fail = report([["OPE-1", "blocked"], ["OPE-3", "done"]]);
  assert.deepEqual(diffReports(pass, fail), { status: "changed", version: { before: "1.7.0", after: "1.7.0" },
    added: [], removed: [], regressions: ["OPE-1"], previous: { verified: true }, current: { verified: false } });
  assert.deepEqual(diffReports(rename(pass, mapping), rename(fail, mapping)), { status: "changed", version: { before: "1.7.0", after: "1.7.0" },
    added: [], removed: [], regressions: ["NEW-12"], previous: { verified: true }, current: { verified: false } });
});
test("task order does not change classification under rename", () => {
  const { renamedBefore, renamedAfter } = fixture();
  renamedBefore.tasks.reverse(); renamedAfter.tasks.reverse();
  const { added, removed, regressions, previous, current } = diffReports(renamedBefore, renamedAfter);
  assert.deepEqual({ added, removed, regressions, previous, current }, {
    added: ["NEW-6", "NEW-7"], removed: ["NEW-5", "NEW-9"], regressions: ["NEW-12", "NEW-3"],
    previous: { verified: false }, current: { verified: false },
  });
});
test("CLI emits exact original and renamed JSON without changing snapshots", t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), "report-bijection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { before, after, renamedBefore, renamedAfter } = fixture();
  for (const [a, b, result] of [[before, after, expected], [renamedBefore, renamedAfter, renamedExpected]]) {
    const first = join(dir, "before.json"); const second = join(dir, "after.json");
    const originalA = JSON.stringify(a); const originalB = JSON.stringify(b);
    writeFileSync(first, originalA); writeFileSync(second, originalB);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./diff.mjs", import.meta.url)), first, second], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr); assert.deepEqual(JSON.parse(run.stdout), result);
    assert.equal(readFileSync(first, "utf8"), originalA); assert.equal(readFileSync(second, "utf8"), originalB);
    assert.equal(JSON.stringify(a), originalA); assert.equal(JSON.stringify(b), originalB);
  }
});
