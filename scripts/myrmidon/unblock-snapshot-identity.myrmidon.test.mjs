import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "./unblock-reasonless.mjs";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rows = () => [
  { id: uuid(1), identifier: "OPE-1", company_id: uuid(101), assignee_agent_id: uuid(11), assignee_user_id: null, status: "blocked", status_version: 7, blocker_metadata: { blockReason: "", marker: "agent" }, unblock_descriptor: { owner: null, action: "" }, blocked_transition_at: "2026-01-01T00:00:00Z", blocked_owner_notified_at: null, updated_at: "2026-01-02T00:00:00Z" },
  { id: uuid(2), identifier: "OPE-2", company_id: uuid(102), assignee_agent_id: null, assignee_user_id: "user-2", status: "blocked", status_version: 23, blocker_metadata: null, unblock_descriptor: { owner: { agentId: uuid(12) }, action: "" }, blocked_transition_at: null, blocked_owner_notified_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-02T00:00:00Z" },
  { id: uuid(3), identifier: "OPE-3", company_id: uuid(103), assignee_agent_id: null, assignee_user_id: null, status: "blocked", status_version: 99, blocker_metadata: { marker: "skipped" }, unblock_descriptor: null, blocked_transition_at: null, blocked_owner_notified_at: null, updated_at: "2026-03-02T00:00:00Z" },
];

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unblock-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = rows();
  const original = structuredClone(input);
  const calls = [];
  const file = path.join(dir, "snapshot.json");
  const port = { query(sql) {
    calls.push(sql);
    if (!sql.includes("update issues")) return input;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original.slice(0, 2));
    assert.ok(sql.includes(uuid(1)) && sql.includes(uuid(2)));
    assert.ok(!sql.includes(uuid(3)));
    return original.slice(0, 2).map(({ id, company_id, identifier }) => ({ id, company_id, identifier }));
  } };
  const plans = [
    { id: uuid(1), identifier: "OPE-1", companyId: uuid(101), before: original[0] },
    { id: uuid(2), identifier: "OPE-2", companyId: uuid(102), before: original[1] },
    { id: uuid(3), identifier: "OPE-3", companyId: uuid(103), skipped: "no assignee" },
  ];
  return { dir, file, input, original, calls, port, plans };
}

test("apply snapshots exact assigned before rows before updates without mutating inputs", async (t) => {
  const s = setup(t);
  const logs = [];
  const result = await run({ port: s.port, apply: true, snapshotPath: s.file, log: (line) => logs.push(line) });
  assert.deepEqual(result, { plans: s.plans, applied: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")), s.original.slice(0, 2));
  if (process.platform === "linux") assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.deepEqual(s.input, s.original);
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[0], /select/i);
  assert.match(s.calls[1], /update issues/i);
  assert.deepEqual(logs, ["OPE-1: blocked without a reason -> todo for its executor", "OPE-2: blocked without a reason -> todo for its executor", "OPE-3: SKIP (no assignee)", `snapshot written: ${s.file}`, "apply: 2 returned to todo; nobody woken, idle pickup takes them"]);
});

test("dry-run does not write a snapshot or issue updates", async (t) => {
  const s = setup(t);
  const logs = [];
  assert.deepEqual(await run({ port: s.port, apply: false, snapshotPath: s.file, log: (line) => logs.push(line) }), { plans: s.plans, applied: 0 });
  assert.deepEqual(fs.readdirSync(s.dir), []);
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0], /select/i);
  assert.equal(logs.at(-1), "dry-run: 2 to return to todo, 1 skipped, nothing written");
  assert.deepEqual(s.input, s.original);
});

test("snapshot write failure prevents updates and retry with a valid path succeeds", async (t) => {
  const s = setup(t);
  await assert.rejects(run({ port: s.port, apply: true, snapshotPath: path.join(s.dir, "missing", "snapshot.json"), log() {} }), { code: "ENOENT" });
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0], /select/i);
  assert.deepEqual(fs.readdirSync(s.dir), []);
  assert.deepEqual(s.input, s.original);
  s.calls.length = 0;
  assert.deepEqual(await run({ port: s.port, apply: true, snapshotPath: s.file, log() {} }), { plans: s.plans, applied: 2 });
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.input, s.original);
});
