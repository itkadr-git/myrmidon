#!/usr/bin/env node
// OPE-9072: one-time data migration for issues the old stranded auto-policy
// (step 3, `vendor_default`) parked in `blocked` with no blocker, no
// blockerMetadata and a "needs a disposition" card for board users.
//
// Selected: status blocked, no unresolved blocker relation, blocker_metadata
// NULL, and a `issue.successful_run_handoff_escalated` activity event written
// at or after the block (5 min slack). Each gets complete blockerMetadata and
// an agent-owned unblockDescriptor; the owner is the first eligible agent of
// the default senior chain (assignee's reports_to upward -> project lead ->
// agent `adm`), same rule as server/src/services/review-escalation-chain.ts.
// The assignee, execution policy and execution state are NOT touched. No
// chain owner -> the issue is reported and left untouched.
//
// This script does not wake anyone. After --apply the operator wakes the
// owners listed in the output (the new server code does this itself for new
// cases).
//
// Usage:
//   DATABASE_URL=postgres://... node escalate-stranded-disposition.mjs            (dry-run, default)
//   DATABASE_URL=postgres://... node escalate-stranded-disposition.mjs --dry-run
//   DATABASE_URL=postgres://... node escalate-stranded-disposition.mjs --apply [--snapshot FILE]
//   optional: --only OPE-9061,OPE-8952
// Dry-run never writes (not even the snapshot).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSeniorChain, psqlPort } from "./escalate-human-reviews-to-agents.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Z]+-\d+$/;
export const ACTION = "Assign a final status to this issue (done, in_review, blocked with a blocker, or todo with a reason)";
export const ESCALATION_POLICY = "stranded_disposition_chain_v1";
const NEXT_CHECK_MS = 4 * 60 * 60 * 1000;
const TIMEOUT_MS = 24 * 60 * 60 * 1000;

const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;

export function selectSql(only) {
  const filter = only?.length ? `and i.identifier in (${only.map(lit).join(",")})` : "";
  return `select coalesce(json_agg(t), '[]'::json) from (
    select i.id, i.identifier, i.company_id, i.assignee_agent_id, p.lead_agent_id as project_lead_agent_id
    from issues i left join projects p on p.id = i.project_id
    where i.status = 'blocked'
      and i.assignee_agent_id is not null
      and i.blocker_metadata is null
      and not exists (select 1 from issue_relations r join issues b on b.id = r.issue_id
                      where r.related_issue_id = i.id and r.type = 'blocks' and b.status not in ('done','cancelled'))
      and exists (select 1 from activity_log a
                  where a.entity_type = 'issue' and a.entity_id = i.id::text
                    and a.action = 'issue.successful_run_handoff_escalated'
                    and a.created_at >= coalesce(i.blocked_transition_at, i.updated_at) - interval '5 minutes')
      ${filter}
    order by i.identifier) t`;
}

/** Pure: the metadata + descriptor written for one issue. */
export function buildPatch(issueId, ownerAgentId, now = new Date()) {
  return {
    blockerMetadata: {
      blockReason: "recovery",
      owner: { agentId: ownerAgentId },
      nextCheckAt: new Date(now.getTime() + NEXT_CHECK_MS).toISOString(),
      timeoutAt: new Date(now.getTime() + TIMEOUT_MS).toISOString(),
      escalationPolicy: ESCALATION_POLICY,
    },
    unblockDescriptor: {
      owner: { agentId: ownerAgentId },
      action: ACTION,
      reasonRef: { kind: "event", eventKey: `stranded.disposition:${issueId}` },
    },
  };
}

/** Pure: plan one issue. */
export function planIssue(row, agents, now = new Date()) {
  const chain = buildSeniorChain({
    agents,
    reviewerAgentId: row.assignee_agent_id,
    projectLeadAgentId: row.project_lead_agent_id ?? null,
    returnAssigneeAgentId: null,
  });
  if (chain.length === 0) return { identifier: row.identifier, id: row.id, skipped: "no eligible agent" };
  const ownerAgentId = chain[0];
  return {
    identifier: row.identifier,
    id: row.id,
    ownerAgentId,
    ownerAgentName: agents.find((a) => a.id === ownerAgentId)?.name ?? null,
    patch: buildPatch(row.id, ownerAgentId, now),
  };
}

export function updateSql(plan, companyId) {
  if (![plan.id, plan.ownerAgentId, companyId].every((v) => UUID.test(v))) throw new Error("bad uuid in plan");
  return `update issues set blocker_metadata = ${lit(JSON.stringify(plan.patch.blockerMetadata))}::jsonb,
    unblock_descriptor = ${lit(JSON.stringify(plan.patch.unblockDescriptor))}::jsonb,
    blocked_owner_notified_at = NULL, updated_at = now()
    where id = '${plan.id}' and company_id = '${companyId}' and status = 'blocked' and blocker_metadata is null returning id`;
}

export async function run({ port, apply, only, snapshotPath, now = new Date(), log = console.log }) {
  if (only?.some((id) => !IDENTIFIER.test(id))) throw new Error("bad identifier in --only");
  const rows = port.query(selectSql(only));
  const byCompany = new Map();
  const plans = [];
  for (const row of rows) {
    if (!byCompany.has(row.company_id)) {
      if (!UUID.test(row.company_id)) throw new Error("bad company id");
      byCompany.set(row.company_id, port.query(
        `select coalesce(json_agg(t), '[]'::json) from (select id, name, status, reports_to, paused_at from agents where company_id = ${lit(row.company_id)}) t`,
      ));
    }
    plans.push({ ...planIssue(row, byCompany.get(row.company_id), now), companyId: row.company_id });
  }
  for (const plan of plans) {
    log(plan.skipped
      ? `${plan.identifier}: SKIP (${plan.skipped})`
      : `${plan.identifier}: blocked, no blocker -> owner agent ${plan.ownerAgentName} (${plan.ownerAgentId})`);
  }
  const todo = plans.filter((p) => !p.skipped);
  if (!apply) {
    log(`dry-run: ${todo.length} to fix, ${plans.length - todo.length} skipped, nothing written`);
    return { plans, applied: 0 };
  }
  if (snapshotPath) {
    fs.writeFileSync(snapshotPath, JSON.stringify(todo.map((p) => ({ id: p.id, identifier: p.identifier, before: { blocker_metadata: null, unblock_descriptor: "see activity_log" } })), null, 2));
    log(`snapshot written: ${snapshotPath}`);
  }
  let applied = 0;
  for (const plan of todo) {
    const out = port.query(`with u as (${updateSql(plan, plan.companyId)}) select coalesce(json_agg(u), '[]'::json) from u`);
    if (out.length === 1) applied += 1;
    else log(`${plan.identifier}: not updated (state changed since read)`);
  }
  log(`apply: ${applied} fixed; wake the owners above (this script does not)`);
  return { plans, applied };
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const dry = argv.includes("--dry-run");
  if (apply && dry) {
    console.error("--dry-run and --apply are mutually exclusive");
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const only = arg("--only")?.split(",").filter(Boolean) ?? null;
  const snapshotPath = apply ? arg("--snapshot") ?? `ope-9072-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json` : null;
  try {
    const { plans, applied } = await run({ port: psqlPort(url), apply, only, snapshotPath });
    if (apply && applied !== plans.filter((p) => !p.skipped).length) return 1;
    return 0;
  } catch (err) {
    console.error(`escalate-stranded-disposition: ${err instanceof Error ? err.message : "failed"}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
