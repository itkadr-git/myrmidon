import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "./escalate-stranded-disposition.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const companyA = id(100);
const companyB = id(200);
const now = new Date("2026-10-24T10:00:00.000Z");
const agent = (n, name, reportsTo = null, status = "idle") => ({
  id: id(n), name, status, reports_to: reportsTo, paused_at: null,
});

function fixture() {
  const rows = [
    { id: id(10), identifier: "TST-1", company_id: companyA, assignee_agent_id: id(3), project_lead_agent_id: null },
    { id: id(20), identifier: "TST-2", company_id: companyB, assignee_agent_id: id(13), project_lead_agent_id: null },
    { id: id(11), identifier: "TST-3", company_id: companyA, assignee_agent_id: id(4), project_lead_agent_id: null },
    { id: id(21), identifier: "TST-4", company_id: companyB, assignee_agent_id: id(14), project_lead_agent_id: null },
  ];
  const rosters = {
    [companyA]: [agent(2, "manager"), agent(3, "worker", id(2)), agent(4, "worker", id(2))],
    [companyB]: [agent(12, "manager"), agent(13, "worker", id(12)), agent(14, "isolated")],
  };
  const lookups = [];
  const updates = [];
  const port = { query(sql) {
    if (sql.includes("from issues i")) return rows;
    if (sql.includes("from agents")) {
      const match = sql.match(/where company_id = '([^']+)'/);
      assert.ok(match && Object.hasOwn(rosters, match[1]), `unexpected roster query: ${sql}`);
      lookups.push(match[1]);
      return rosters[match[1]];
    }
    if (sql.includes("update issues")) {
      const match = sql.match(/where id = '([^']+)' and company_id = '([^']+)'/);
      assert.ok(match, `unscoped update: ${sql}`);
      updates.push({ id: match[1], companyId: match[2], sql });
      return [{ id: match[1] }];
    }
    assert.fail(`unexpected query: ${sql}`);
  } };
  return { rows, rosters, lookups, updates, port };
}

function assertPlans(plans, ownerA = id(2), ownerB = id(12)) {
  assert.deepEqual(plans.map(({ identifier, id: issueId, companyId, ownerAgentId, skipped }) =>
    ({ identifier, id: issueId, companyId, ownerAgentId, skipped })), [
    { identifier: "TST-1", id: id(10), companyId: companyA, ownerAgentId: ownerA, skipped: undefined },
    { identifier: "TST-2", id: id(20), companyId: companyB, ownerAgentId: ownerB, skipped: undefined },
    { identifier: "TST-3", id: id(11), companyId: companyA, ownerAgentId: ownerA, skipped: undefined },
    { identifier: "TST-4", id: id(21), companyId: companyB, ownerAgentId: undefined, skipped: "no eligible agent" },
  ]);
  for (const plan of plans.filter((p) => !p.skipped)) {
    assert.equal(plan.ownerAgentName, "manager");
    assert.deepEqual(plan.patch.blockerMetadata.owner, { agentId: plan.ownerAgentId });
    assert.deepEqual(plan.patch.unblockDescriptor.owner, { agentId: plan.ownerAgentId });
    assert.deepEqual(plan.patch.unblockDescriptor.reasonRef, { kind: "event", eventKey: `stranded.disposition:${plan.id}` });
  }
}

describe("stranded company roster cache", () => {
  for (const apply of [false, true]) {
    it(`${apply ? "apply" : "dry-run"} isolates alternating companies and preserves inputs`, async () => {
      const f = fixture();
      const before = structuredClone({ rows: f.rows, rosters: f.rosters });
      const logs = [];
      const result = await run({ port: f.port, apply, now, log: (message) => logs.push(message) });
      assertPlans(result.plans);
      assert.deepEqual(f.lookups, [companyA, companyB]);
      assert.equal(result.applied, apply ? 3 : 0);
      assert.deepEqual(f.updates.map(({ id: issueId, companyId }) => ({ id: issueId, companyId })), apply ? [
        { id: id(10), companyId: companyA }, { id: id(20), companyId: companyB }, { id: id(11), companyId: companyA },
      ] : []);
      for (const update of f.updates) {
        const owner = update.companyId === companyA ? id(2) : id(12);
        assert.ok(update.sql.includes(`"agentId":"${owner}"`));
        assert.ok(update.sql.includes(`stranded.disposition:${update.id}`));
      }
      assert.ok(logs.includes("TST-4: SKIP (no eligible agent)"));
      assert.deepEqual({ rows: f.rows, rosters: f.rosters }, before);
    });
  }

  it("refreshes rosters for each run on the same port", async () => {
    const f = fixture();
    const beforeRows = structuredClone(f.rows);
    const originalRosters = { ...f.rosters };
    const firstRosters = structuredClone(originalRosters);
    const first = await run({ port: f.port, apply: false, now, log: () => {} });
    assertPlans(first.plans);
    f.rosters[companyA] = [agent(22, "manager"), agent(3, "worker", id(22)), agent(4, "worker", id(22))];
    f.rosters[companyB] = [agent(32, "manager"), agent(13, "worker", id(32)), agent(14, "isolated")];
    const secondRosters = structuredClone(f.rosters);
    const second = await run({ port: f.port, apply: false, now, log: () => {} });
    assertPlans(second.plans, id(22), id(32));
    assert.deepEqual(f.lookups, [companyA, companyB, companyA, companyB]);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.rows, beforeRows);
    assert.deepEqual(originalRosters, firstRosters);
    assert.deepEqual(f.rosters, secondRosters);
  });
});
