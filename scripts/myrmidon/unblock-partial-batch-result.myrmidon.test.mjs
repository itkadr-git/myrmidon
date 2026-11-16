import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { run } from "./unblock-reasonless.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n, assigned = true) => ({
  id: id(n), identifier: `OPE-${n}`, company_id: id(999),
  assignee_agent_id: assigned ? id(998) : null, assignee_user_id: null,
  status: "blocked", status_version: n,
});
const plan = (r) => r.assignee_agent_id || r.assignee_user_id
  ? { id: r.id, identifier: r.identifier, companyId: r.company_id, before: r }
  : { id: r.id, identifier: r.identifier, companyId: r.company_id, skipped: "no assignee" };
const quiet = () => {};

it("applies partial batch results without updating skipped rows or mutating input", async (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "unblock-partial-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "snapshot.json");
  const eligible = Array.from({ length: 21 }, (_, n) => row(n + 1));
  const skipped = [row(51, false), row(52, false)];
  const rows = [...eligible.slice(0, 5), skipped[0], ...eligible.slice(5), skipped[1]];
  const original = structuredClone(rows);
  const batches = [];
  const logs = [];
  const port = { query(sql) {
    if (!sql.includes("update issues")) return rows;
    assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), eligible);
    const ids = [...sql.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
    batches.push(ids);
    return ids.slice(0, [8, 0, 1][batches.length - 1]).map((id) => ({ id }));
  } };
  const result = await run({ port, apply: true, snapshotPath, log: (message) => logs.push(message) });
  assert.deepEqual(result, { plans: original.map(plan), applied: 9 });
  assert.deepEqual(batches, [eligible.slice(0, 10).map((r) => r.id), eligible.slice(10, 20).map((r) => r.id), [eligible[20].id]]);
  assert.deepEqual(rows, original);
  assert.ok(logs.includes("batch of 10: 8 updated (state changed since read)"));
  assert.ok(logs.includes("batch of 10: 0 updated (state changed since read)"));
  assert.ok(logs.includes("apply: 9 returned to todo; nobody woken, idle pickup takes them"));
});

it("does not update when the read is empty", async () => {
  const calls = [];
  const result = await run({ port: { query(sql) { calls.push(sql); return []; } }, apply: true, log: quiet });
  assert.deepEqual(result, { plans: [], applied: 0 });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /update issues/);
});

it("stops immediately when the first update throws", async () => {
  const rows = Array.from({ length: 21 }, (_, n) => row(n + 1));
  const calls = [];
  const failure = new Error("update failed");
  const port = { query(sql) { calls.push(sql); if (calls.length === 1) return rows; throw failure; } };
  await assert.rejects(run({ port, apply: true, log: quiet }), (err) => err === failure);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /update issues/);
});

it("keeps plans and applied counts independent across runs", async () => {
  const first = row(1);
  const second = row(2);
  const port = (r) => ({ query(sql) { return sql.includes("update issues") ? [{ id: r.id }] : [r]; } });
  assert.deepEqual(await run({ port: port(first), apply: true, log: quiet }), { plans: [plan(first)], applied: 1 });
  assert.deepEqual(await run({ port: port(second), apply: false, log: quiet }), { plans: [plan(second)], applied: 0 });
});
