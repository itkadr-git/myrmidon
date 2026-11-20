import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "./close-orphan-wakeup-requests.mjs";

const claimed = { id: "00000000-0000-4000-8000-000000000001", status: "claimed", idempotency_key: null, reason: "old claim" };
const admission = { id: "00000000-0000-4000-8000-000000000002", status: "queued", idempotency_key: "issue-review-admission:example", reason: "review" };
const untouched = { id: "00000000-0000-4000-8000-000000000003", status: "queued", idempotency_key: "other", reason: "keep" };
const rows = [admission, untouched, claimed];
const expectedPlan = { failed: [claimed], coalesced: [admission], untouched: [untouched] };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-barrier-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "snapshot.json");
}

function fakePort(selected, onUpdate = () => {}) {
  const calls = [];
  return {
    calls,
    query(sql) {
      calls.push(sql);
      if (calls.length === 1) return selected;
      assert.match(sql, /^with u as \(update agent_wakeup_requests/);
      onUpdate(sql, calls.length - 1);
      if (sql.includes("status = 'failed'")) return [{ id: claimed.id }];
      if (sql.includes("status = 'coalesced'")) return [{ id: admission.id }];
      assert.fail("unexpected update");
    },
  };
}

test("snapshot contains exactly both planned groups before the first update", (t) => {
  const snapshotPath = fixture(t);
  const port = fakePort(rows, (sql, n) => {
    assert.equal(fs.readFileSync(snapshotPath, "utf8"), JSON.stringify([claimed, admission], null, 2));
    assert.ok(sql.includes(n === 1 ? claimed.id : admission.id));
    assert.ok(!sql.includes(untouched.id));
  });
  const logs = [];
  const result = run({ port, apply: true, snapshotPath, log: (line) => logs.push(line) });
  assert.deepEqual(result, { plan: expectedPlan, applied: 2 });
  assert.equal(port.calls.length, 3);
  assert.deepEqual(logs, ["claimed -> failed: 1", "queued review-admission -> coalesced: 1", "queued, left alone: 1", `snapshot written: ${snapshotPath}`, "apply: 2 of 2 closed"]);
});

test("snapshot failure prevents updates and a subsequent run has a fresh plan", (t) => {
  const snapshotPath = fixture(t);
  const port = fakePort(rows);
  assert.throws(() => run({ port, apply: true, snapshotPath: path.join(snapshotPath, "missing", "snapshot.json"), log() {} }), { code: "ENOENT" });
  assert.equal(port.calls.length, 1);
  const retry = fakePort([admission], () => {
    assert.equal(fs.readFileSync(snapshotPath, "utf8"), JSON.stringify([admission], null, 2));
  });
  assert.deepEqual(run({ port: retry, apply: true, snapshotPath, log() {} }), {
    plan: { failed: [], coalesced: [admission], untouched: [] }, applied: 1,
  });
  assert.equal(retry.calls.length, 2);
});

test("dry-run does not create the requested snapshot or update rows", (t) => {
  const snapshotPath = fixture(t);
  const port = fakePort(rows);
  const logs = [];
  assert.deepEqual(run({ port, apply: false, snapshotPath, log: (line) => logs.push(line) }), { plan: expectedPlan, applied: 0 });
  assert.equal(fs.existsSync(snapshotPath), false);
  assert.equal(port.calls.length, 1);
  assert.deepEqual(logs, ["claimed -> failed: 1", "queued review-admission -> coalesced: 1", "queued, left alone: 1", "dry-run: nothing written"]);
});

test("apply with an empty selection writes an empty snapshot and performs no updates", (t) => {
  const snapshotPath = fixture(t);
  const port = fakePort([]);
  const logs = [];
  assert.deepEqual(run({ port, apply: true, snapshotPath, log: (line) => logs.push(line) }), {
    plan: { failed: [], coalesced: [], untouched: [] }, applied: 0,
  });
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), "[]");
  assert.equal(port.calls.length, 1);
  assert.deepEqual(logs, ["claimed -> failed: 0", "queued review-admission -> coalesced: 0", "queued, left alone: 0", `snapshot written: ${snapshotPath}`, "apply: 0 of 0 closed"]);
});
