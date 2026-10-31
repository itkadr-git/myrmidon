import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPatch, planIssue, run, selectSql, updateSql } from "./escalate-stranded-disposition.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const agents = [
  { id: id(1), name: "adm", status: "idle", reports_to: null, paused_at: null },
  { id: id(2), name: "mgr", status: "idle", reports_to: id(1), paused_at: null },
  { id: id(3), name: "exec", status: "idle", reports_to: id(2), paused_at: null },
  { id: id(5), name: "lead", status: "idle", reports_to: id(1), paused_at: null },
];
const row = { id: id(10), identifier: "OPE-1", company_id: id(99), assignee_agent_id: id(3), project_lead_agent_id: id(5) };
const now = new Date("2026-10-24T10:00:00.000Z");

describe("escalate-stranded-disposition", () => {
  it("owner is the assignee's manager first", () => {
    const plan = planIssue(row, agents, now);
    assert.equal(plan.ownerAgentId, id(2));
    assert.deepEqual(plan.patch.blockerMetadata.owner, { agentId: id(2) });
    assert.equal(plan.patch.blockerMetadata.nextCheckAt, "2026-10-24T14:00:00.000Z");
  });
  it("falls back to the project lead, then adm", () => {
    const noMgr = agents.map((a) => (a.id === id(3) ? { ...a, reports_to: null } : a));
    assert.equal(planIssue(row, noMgr, now).ownerAgentId, id(5));
    assert.equal(planIssue({ ...row, project_lead_agent_id: null }, noMgr, now).ownerAgentId, id(1));
  });
  it("skips an issue with an empty chain", () => {
    assert.ok(planIssue({ ...row, assignee_agent_id: id(1), project_lead_agent_id: null }, [agents[0]], now).skipped);
  });
  it("descriptor is agent-owned with a still-set event reason", () => {
    const p = buildPatch(row.id, id(2), now);
    assert.deepEqual(p.unblockDescriptor.owner, { agentId: id(2) });
    assert.equal(p.unblockDescriptor.reasonRef.kind, "event");
  });
  it("update is guarded and select is restricted to the handoff event", () => {
    assert.match(updateSql(planIssue(row, agents, now), row.company_id), /blocker_metadata is null returning id/);
    assert.match(selectSql(null), /successful_run_handoff_escalated/);
  });
  it("rejects a malformed --only identifier", async () => {
    await assert.rejects(run({ port: {}, only: ["x'"] }), /bad identifier/);
  });
  it("dry-run writes nothing, apply updates", async () => {
    const queries = [];
    const port = {
      query(sql) {
        queries.push(sql);
        if (sql.includes("from issues i")) return [row];
        if (sql.includes("from agents")) return agents;
        return [{ id: row.id }];
      },
    };
    const logs = [];
    await run({ port, apply: false, now, log: (m) => logs.push(m) });
    assert.ok(!queries.some((q) => q.includes("update issues")));
    const res = await run({ port, apply: true, now, log: (m) => logs.push(m) });
    assert.equal(res.applied, 1);
    assert.ok(queries.some((q) => q.includes("update issues")));
  });
});
