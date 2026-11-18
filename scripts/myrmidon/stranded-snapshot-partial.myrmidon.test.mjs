import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { run } from "./escalate-stranded-disposition.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-24T10:00:00.000Z");
const rows = [
  { id: id(10), identifier: "OPE-10", company_id: id(90), assignee_agent_id: id(3), project_lead_agent_id: null },
  { id: id(11), identifier: "OPE-11", company_id: id(90), assignee_agent_id: id(3), project_lead_agent_id: null },
  { id: id(12), identifier: "OPE-12", company_id: id(91), assignee_agent_id: id(4), project_lead_agent_id: null },
];
const agents = [
  { id: id(2), name: "manager", status: "idle", reports_to: null, paused_at: null },
  { id: id(3), name: "worker", status: "idle", reports_to: id(2), paused_at: null },
];
const skippedAgents = [{ id: id(4), name: "worker", status: "idle", reports_to: null, paused_at: null }];
const expectedSnapshot = rows.slice(0, 2).map(({ id, identifier }) => ({
  id, identifier, before: { blocker_metadata: null, unblock_descriptor: "see activity_log" },
}));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stranded-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "snapshot.json");
}

function fakePort(snapshotPath, replies = []) {
  const updates = [];
  return {
    updates,
    query(sql) {
      if (sql.includes("from issues i")) return rows;
      if (sql.includes("from agents")) return sql.includes(id(90)) ? agents : skippedAgents;
      assert.match(sql, /update issues/);
      assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), expectedSnapshot);
      assert.doesNotMatch(sql, /\b(?:assignee_agent_id|execution_policy|execution_state)\s*=/i);
      updates.push(sql);
      return replies[updates.length - 1] ?? [];
    },
  };
}

function checkPlans(plans) {
  assert.equal(plans.length, 3);
  assert.deepEqual(plans.map((p) => p.identifier), ["OPE-10", "OPE-11", "OPE-12"]);
  for (const [index, plan] of plans.slice(0, 2).entries()) {
    assert.deepEqual(plan, {
      id: rows[index].id, identifier: rows[index].identifier, companyId: id(90),
      ownerAgentId: id(2), ownerAgentName: "manager",
      patch: {
        blockerMetadata: { blockReason: "recovery", owner: { agentId: id(2) }, nextCheckAt: "2026-10-24T14:00:00.000Z", timeoutAt: "2026-10-25T10:00:00.000Z", escalationPolicy: "stranded_disposition_chain_v1" },
        unblockDescriptor: { owner: { agentId: id(2) }, action: "Assign a final status to this issue (done, in_review, blocked with a blocker, or todo with a reason)", reasonRef: { kind: "event", eventKey: `stranded.disposition:${rows[index].id}` } },
      },
    });
  }
  assert.deepEqual(plans[2], { id: id(12), identifier: "OPE-12", skipped: "no eligible agent", companyId: id(91) });
}

it("writes only eligible before-images before updates and counts returned rows", async (t) => {
  const snapshotPath = fixture(t);
  const port = fakePort(snapshotPath, [[], [{ id: id(11) }]]);
  const logs = [];
  const result = await run({ port, apply: true, snapshotPath, now, log: (s) => logs.push(s) });
  checkPlans(result.plans);
  assert.equal(result.applied, 1);
  assert.equal(port.updates.length, 2);
  assert.match(port.updates[0], new RegExp(id(10)));
  assert.match(port.updates[1], new RegExp(id(11)));
  assert.ok(logs.includes("OPE-10: not updated (state changed since read)"));
});

it("dry-run returns plans but does not create a snapshot or update", async (t) => {
  const snapshotPath = fixture(t);
  const port = fakePort(snapshotPath);
  const result = await run({ port, apply: false, snapshotPath, now, log: () => {} });
  checkPlans(result.plans);
  assert.equal(result.applied, 0);
  assert.equal(port.updates.length, 0);
  assert.equal(fs.existsSync(snapshotPath), false);
});

it("snapshot failure stops updates and a later successful run starts with fresh plans", async (t) => {
  const snapshotPath = fixture(t);
  const port = fakePort(snapshotPath, [[{ id: id(10) }], [{ id: id(11) }]]);
  await assert.rejects(run({ port, apply: true, snapshotPath: path.join(snapshotPath, "missing", "snapshot.json"), now, log: () => {} }), { code: "ENOENT" });
  assert.equal(port.updates.length, 0);
  const result = await run({ port, apply: true, snapshotPath, now, log: () => {} });
  checkPlans(result.plans);
  assert.equal(result.applied, 2);
  assert.equal(port.updates.length, 2);
});
