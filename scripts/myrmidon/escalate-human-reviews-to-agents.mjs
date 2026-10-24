#!/usr/bin/env node
// OPE-9031: one-time data migration. Review stages that were escalated to a
// human user at the round limit are moved to an agent by the rule of the
// default senior chain (server/src/services/review-escalation-chain.ts):
//   managers of the previous reviewer upward (agents.reports_to),
//   then the project lead (projects.lead_agent_id), then the top agent `adm`.
// Escalated = escalationReason review_round_limit, or the legacy shape
// (counter >= limit and lastDecisionOutcome changes_requested, no reason field).
// Skipped: the previous reviewer, the executor (returnAssignee), paused and
// terminated agents. No agent -> the issue is reported and left untouched.
//
// The participant and the assignee change together, exactly like
// buildPendingStagePatch: status in_review, assignee_agent_id = agent,
// assignee_user_id = NULL, execution_state.currentParticipant = agent.
//
// Usage:
//   DATABASE_URL=postgres://... node escalate-human-reviews-to-agents.mjs --dry-run
//   DATABASE_URL=postgres://... node escalate-human-reviews-to-agents.mjs --apply [--snapshot FILE]
//   optional: --only OPE-8239,OPE-8575  (restrict to identifiers)
// --dry-run reads and prints the plan, it never writes (not even the snapshot).
// --apply first writes a JSON snapshot of every row it will change, then updates
// each issue in its own statement guarded by the execution_state it read.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const REVISION = "default-senior-chain";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Z]+-\d+$/;

const isEligible = (a) => a.status !== "paused" && a.status !== "terminated" && !a.paused_at;

/** Same rule as buildSeniorChain in the server. */
export function buildSeniorChain({ agents, reviewerAgentId, projectLeadAgentId, returnAssigneeAgentId }) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out = [];
  const push = (id) => {
    if (!id || out.includes(id) || id === reviewerAgentId || id === returnAssigneeAgentId) return;
    const a = byId.get(id);
    if (a && isEligible(a)) out.push(id);
  };
  const seen = new Set();
  let cursor = reviewerAgentId ? byId.get(reviewerAgentId)?.reports_to ?? null : null;
  for (let depth = 0; cursor && depth < 32 && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    push(cursor);
    cursor = byId.get(cursor)?.reports_to ?? null;
  }
  push(projectLeadAgentId);
  push(agents.find((a) => a.reports_to == null && String(a.name).trim().toLowerCase() === "adm")?.id);
  return out;
}

/** Pure: the state after the move (mirrors buildPendingState for an escalation). */
export function escalatedState(state, agentId) {
  const from = state.currentParticipant;
  const to = { type: "agent", agentId, userId: null };
  return {
    ...state,
    status: "pending",
    currentParticipant: to,
    escalationPolicyRevision: state.escalationPolicyRevision ?? REVISION,
    escalationReason: "review_round_limit",
    escalationFromParticipant: from,
    escalationToParticipant: to,
    changesRequestedCount: 0,
  };
}

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

/** Same rule as resolveMaxReviewRounds on the server. */
export function maxReviewRounds(policy) {
  const configured = policy?.reviewEscalationPolicy?.maxReviewRounds ?? policy?.maxReviewRounds;
  return typeof configured === "number" && configured > 0 ? configured : DEFAULT_MAX_REVIEW_ROUNDS;
}

/**
 * Pure: a stage escalated to a user at the round limit. Either the explicit
 * mark (escalationReason = review_round_limit) or the legacy shape written by
 * the old code, which handed the stage to responsibleUserId without a reason:
 * the round counter reached the limit and the last decision was changes_requested.
 * A plain human review (counter below the limit) is not ours.
 */
export function isEscalatedToUser(state, policy = null) {
  if (!state || state.status !== "pending" || state.currentParticipant?.type !== "user") return false;
  if (state.escalationReason === "review_round_limit") {
    return state.escalationToParticipant == null || state.escalationToParticipant.type === "user";
  }
  return (state.changesRequestedCount ?? 0) >= maxReviewRounds(policy) && state.lastDecisionOutcome === "changes_requested";
}

/** Pure: plan one issue. */
export function planIssue(row, agents) {
  const state = row.execution_state;
  const from = state.escalationFromParticipant;
  // Legacy escalations carry no escalationFromParticipant: the previous reviewer
  // is the first agent of the current stage's roster.
  const stage = (row.execution_policy?.stages ?? []).find((st) => st.id === state.currentStageId);
  const rosterAgent = (stage?.participants ?? []).find((pt) => pt.type === "agent" && pt.agentId)?.agentId ?? null;
  const reviewerAgentId = from?.type === "agent" ? from.agentId ?? null : row.assignee_agent_id ?? rosterAgent;
  const ret = state.returnAssignee;
  const chain = buildSeniorChain({
    agents,
    reviewerAgentId,
    projectLeadAgentId: row.project_lead_agent_id ?? null,
    returnAssigneeAgentId: ret?.type === "agent" ? ret.agentId ?? null : null,
  });
  if (chain.length === 0) return { identifier: row.identifier, id: row.id, skipped: "no eligible agent" };
  const agentId = chain[0];
  return {
    identifier: row.identifier,
    id: row.id,
    fromUserId: state.currentParticipant?.userId ?? null,
    toAgentId: agentId,
    toAgentName: agents.find((a) => a.id === agentId)?.name ?? null,
    before: state,
    after: escalatedState(state, agentId),
  };
}

const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;

export function selectSql(only) {
  const filter = only?.length ? `and i.identifier in (${only.map(lit).join(",")})` : "";
  return `select coalesce(json_agg(t), '[]'::json) from (
    select i.id, i.identifier, i.company_id, i.status, i.assignee_agent_id, i.assignee_user_id,
           i.execution_state, i.execution_policy, p.lead_agent_id as project_lead_agent_id
    from issues i left join projects p on p.id = i.project_id
    where i.status = 'in_review'
      and i.execution_state->>'status' = 'pending'
      and i.execution_state->'currentParticipant'->>'type' = 'user'
      and (i.execution_state->>'escalationReason' = 'review_round_limit'
           or i.execution_state->>'lastDecisionOutcome' = 'changes_requested')
      ${filter}
    order by i.identifier) t`;
}

export function updateSql(plan, companyId) {
  if (![plan.id, plan.toAgentId, companyId].every((v) => UUID.test(v))) throw new Error("bad uuid in plan");
  return `update issues set status = 'in_review', assignee_agent_id = '${plan.toAgentId}', assignee_user_id = NULL,
    execution_state = ${lit(JSON.stringify(plan.after))}::jsonb, updated_at = now()
    where id = '${plan.id}' and execution_state = ${lit(JSON.stringify(plan.before))}::jsonb
      and status = 'in_review' and assignee_user_id is not null returning id`;
}

export async function run({ port, apply, only, snapshotPath, log = console.log }) {
  if (only?.some((id) => !IDENTIFIER.test(id))) throw new Error("bad identifier in --only");
  const rows = port.query(selectSql(only));
  const plans = [];
  const byCompany = new Map();
  for (const row of rows.filter((r) => isEscalatedToUser(r.execution_state, r.execution_policy))) {
    if (!byCompany.has(row.company_id)) {
      byCompany.set(row.company_id, port.query(
        `select coalesce(json_agg(t), '[]'::json) from (select id, name, status, reports_to, paused_at from agents where company_id = ${lit(row.company_id)}) t`,
      ));
    }
    plans.push({ ...planIssue(row, byCompany.get(row.company_id)), companyId: row.company_id });
  }
  for (const plan of plans) {
    log(plan.skipped
      ? `${plan.identifier}: SKIP (${plan.skipped})`
      : `${plan.identifier}: user ${plan.fromUserId} -> agent ${plan.toAgentName} (${plan.toAgentId})`);
  }
  const todo = plans.filter((p) => !p.skipped);
  if (!apply) {
    log(`dry-run: ${todo.length} to move, ${plans.length - todo.length} skipped, nothing written`);
    return { plans, applied: 0 };
  }
  if (snapshotPath) {
    fs.writeFileSync(snapshotPath, JSON.stringify(rows.filter((r) => todo.some((p) => p.id === r.id)), null, 2));
    log(`snapshot written: ${snapshotPath}`);
  }
  let applied = 0;
  for (const plan of todo) {
    const out = port.query(`with u as (${updateSql(plan, plan.companyId)}) select coalesce(json_agg(u), '[]'::json) from u`);
    if (out.length === 1) applied += 1;
    else log(`${plan.identifier}: not updated (state changed since read)`);
  }
  log(`apply: ${applied} moved`);
  return { plans, applied };
}

/** Connection settings go through the environment, never through argv (the URL carries the password). */
export function pgEnvFromUrl(url, base = process.env) {
  const u = new URL(url);
  const env = { ...base };
  for (const k of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE"]) delete env[k];
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (db) env.PGDATABASE = db;
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  delete env.DATABASE_URL;
  return env;
}

export function psqlPort(url) {
  const env = pgEnvFromUrl(url);
  return {
    query(sql) {
      let out;
      try {
        out = execFileSync("psql", ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        // Never print err.cmd / err.message: they carry the command line.
        const detail = String(err?.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
        throw new Error(`psql failed (exit ${err?.status ?? "?"})${detail ? `: ${detail}` : ""}`);
      }
      const line = out.split("\n").find((l) => l.trim().startsWith("["));
      return line ? JSON.parse(line) : [];
    },
  };
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const dry = argv.includes("--dry-run");
  if (apply === dry) {
    console.error("exactly one of --dry-run / --apply is required");
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const only = arg("--only")?.split(",").filter(Boolean) ?? null;
  const snapshotPath = apply ? arg("--snapshot") ?? `ope-9031-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json` : null;
  try {
    const { plans, applied } = await run({ port: psqlPort(url), apply, only, snapshotPath });
    // An apply that left planned moves undone (state changed) is not a clean run.
    if (apply && applied !== plans.filter((p) => !p.skipped).length) return 1;
    return 0;
  } catch (err) {
    console.error(`escalate-human-reviews-to-agents: ${err instanceof Error ? err.message : "failed"}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
