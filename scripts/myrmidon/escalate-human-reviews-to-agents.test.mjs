import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSeniorChain, escalatedState, isEscalatedToUser, pgEnvFromUrl, planIssue, run, selectSql } from "./escalate-human-reviews-to-agents.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "yzDw6KlDhnBeq3EsLzWPtVvtxcvUcFVo";
const agents = [
  { id: id(1), name: "adm", status: "idle", reports_to: null, paused_at: null },
  { id: id(2), name: "mgr", status: "idle", reports_to: id(1), paused_at: null },
  { id: id(3), name: "rev", status: "idle", reports_to: id(2), paused_at: null },
  { id: id(4), name: "exec", status: "idle", reports_to: id(2), paused_at: null },
  { id: id(5), name: "lead", status: "idle", reports_to: id(1), paused_at: null },
];
const state = {
  status: "pending", currentStageId: "s", currentParticipant: { type: "user", userId: USER, agentId: null },
  returnAssignee: { type: "agent", agentId: id(4), userId: null },
  escalationFromParticipant: { type: "agent", agentId: id(3), userId: null }, escalationReason: "review_round_limit",
  escalationToParticipant: { type: "user", userId: USER, agentId: null }, changesRequestedCount: 3,
};
const row = { id: id(10), identifier: "OPE-1", company_id: id(99), status: "in_review", assignee_agent_id: null,
  assignee_user_id: USER, execution_state: state, project_lead_agent_id: id(5) };

describe("escalate-human-reviews-to-agents", () => {
  it("picks the reviewer's manager first, then upward, lead, adm", () => {
    assert.deepEqual(buildSeniorChain({ agents, reviewerAgentId: id(3), projectLeadAgentId: id(5), returnAssigneeAgentId: id(4) }), [id(2), id(1), id(5)]);
  });
  it("skips paused agents and falls to the project lead then adm", () => {
    const paused = agents.map((a) => (a.id === id(2) ? { ...a, status: "paused" } : a));
    assert.deepEqual(buildSeniorChain({ agents: paused, reviewerAgentId: id(3), projectLeadAgentId: id(5), returnAssigneeAgentId: id(4) }), [id(1), id(5)]);
  });
  it("plans participant and assignee together", () => {
    const plan = planIssue(row, agents);
    assert.equal(plan.toAgentId, id(2));
    assert.deepEqual(plan.after.currentParticipant, { type: "agent", agentId: id(2), userId: null });
    assert.equal(plan.after.changesRequestedCount, 0);
    assert.equal(escalatedState(state, id(2)).escalationReason, "review_round_limit");
  });
  it("reports an issue with no eligible agent and never picks a human", () => {
    assert.match(planIssue(row, []).skipped, /no eligible/);
  });
  it("dry-run reads only: no snapshot, no update", async () => {
    const calls = [];
    const port = { query(sql) { calls.push(sql); return /from issues i/.test(sql) ? [row] : agents; } };
    const out = await run({ port, apply: false, snapshotPath: "/nonexistent/should-not-be-written.json", log: () => {} });
    assert.equal(out.applied, 0);
    assert.ok(calls.every((sql) => !/\bupdate issues\b/.test(sql)));
  });
  it("leaves a plain human review (no round-limit escalation) alone", async () => {
    const plain = { ...row, id: id(11), identifier: "OPE-2", execution_state: { ...state, escalationReason: undefined, escalationToParticipant: undefined } };
    assert.equal(isEscalatedToUser(plain.execution_state), false);
    assert.equal(isEscalatedToUser(state), true);
    const calls = [];
    const port = { query(sql) { calls.push(sql); return /from issues i/.test(sql) ? [plain] : agents; } };
    const out = await run({ port, apply: true, snapshotPath: null, log: () => {} });
    assert.equal(out.plans.length, 0);
    assert.equal(out.applied, 0);
    assert.ok(calls.every((sql) => !/\bupdate issues\b/.test(sql)));
  });
  it("selects only round-limit escalations in SQL", () => {
    assert.match(selectSql(null), /escalationReason'\s*=\s*'review_round_limit'/);
  });
  it("passes the connection through the environment, not argv", () => {
    const env = pgEnvFromUrl("postgres://u:p%40ss@db.example:5433/mydb?sslmode=require", {});
    assert.deepEqual([env.PGHOST, env.PGPORT, env.PGUSER, env.PGPASSWORD, env.PGDATABASE, env.PGSSLMODE], ["db.example", "5433", "u", "p@ss", "mydb", "require"]);
    assert.equal(env.DATABASE_URL, undefined);
  });
});
