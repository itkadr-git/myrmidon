#!/usr/bin/env node
// OPE-8904: one-time data migration for tasks parked in `blocked` with no open
// blocker, no blockerMetadata.blockReason and no unblockDescriptor with an
// owner and an action. They are returned to `todo` for their executor (the
// assignee). The product now refuses such a block (422 blocked_requires_reason).
//
// Selected: status blocked, an assignee (agent or user), not a chat
// conversation, every blocker relation closed (done / cancelled) or absent, no
// blockReason, no complete unblock descriptor. Tasks without an assignee are
// reported and left untouched.
//
// Safety: dry-run by default and writes nothing (not even the snapshot).
// --apply first writes the snapshot (full "before" row per task), then updates
// in batches of 10, each update re-checking the selection predicate. Nobody is
// woken: the regular idle pickup takes the todo tasks.
//
// Usage:
//   DATABASE_URL=postgres://... node unblock-reasonless.mjs                 (dry-run, default)
//   DATABASE_URL=postgres://... node unblock-reasonless.mjs --dry-run
//   DATABASE_URL=postgres://... node unblock-reasonless.mjs --apply [--snapshot FILE]
//   optional: --only OPE-9061,OPE-8952

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { psqlPort } from "./escalate-human-reviews-to-agents.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Z]+-\d+$/;
export const BATCH_SIZE = 10;

const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;

/** The predicate shared by the read and by every guarded update. */
export function reasonlessPredicate(alias = "i") {
  const i = alias;
  return `${i}.status = 'blocked'
      and ${i}.conversation_agent_id is null
      and not exists (select 1 from issue_relations r join issues b on b.id = r.issue_id
                      where r.related_issue_id = ${i}.id and r.type = 'blocks' and b.status not in ('done','cancelled'))
      and coalesce(btrim(${i}.blocker_metadata->>'blockReason'), '') = ''
      and not (coalesce(${i}.unblock_descriptor->'owner', 'null'::jsonb) <> 'null'::jsonb
               and coalesce(btrim(${i}.unblock_descriptor->>'action'), '') <> '')`;
}

export function selectSql(only) {
  const filter = only?.length ? `and i.identifier in (${only.map(lit).join(",")})` : "";
  return `select coalesce(json_agg(t), '[]'::json) from (
    select i.id, i.identifier, i.company_id, i.assignee_agent_id, i.assignee_user_id, i.status,
           i.status_version, i.blocker_metadata, i.unblock_descriptor, i.blocked_transition_at,
           i.blocked_owner_notified_at, i.updated_at
    from issues i
    where ${reasonlessPredicate("i")}
      ${filter}
    order by i.identifier) t`;
}

/** Pure: plan one row. */
export function planIssue(row) {
  if (!row.assignee_agent_id && !row.assignee_user_id) {
    return { id: row.id, identifier: row.identifier, companyId: row.company_id, skipped: "no assignee" };
  }
  return { id: row.id, identifier: row.identifier, companyId: row.company_id, before: row };
}

export function chunk(list, size = BATCH_SIZE) {
  const out = [];
  for (let n = 0; n < list.length; n += size) out.push(list.slice(n, n + size));
  return out;
}

export function updateSql(plans) {
  if (plans.length === 0 || plans.length > BATCH_SIZE) throw new Error("bad batch size");
  if (!plans.every((p) => UUID.test(p.id) && UUID.test(p.companyId))) throw new Error("bad uuid in plan");
  const ids = plans.map((p) => lit(p.id)).join(",");
  return `with u as (
    update issues i set status = 'todo', blocker_metadata = null, unblock_descriptor = null,
      blocked_transition_at = null, blocked_owner_notified_at = null,
      status_version = i.status_version + 1, updated_at = now()
    where i.id in (${ids}) and ${reasonlessPredicate("i")}
      and (i.assignee_agent_id is not null or i.assignee_user_id is not null)
    returning i.id, i.company_id, i.identifier
  ), a as (
    insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
    select u.company_id, 'system', 'blocked_reason_guard', 'issue.updated', 'issue', u.id::text,
           jsonb_build_object('identifier', u.identifier, 'status', 'todo', 'previousStatus', 'blocked',
                              'source', 'blocked_reason_guard.migration')
    from u returning 1
  ) select coalesce(json_agg(u), '[]'::json) from u`;
}

export async function run({ port, apply, only, snapshotPath, log = console.log }) {
  if (only?.some((id) => !IDENTIFIER.test(id))) throw new Error("bad identifier in --only");
  const rows = port.query(selectSql(only));
  const plans = rows.map(planIssue);
  const todo = plans.filter((p) => !p.skipped);
  for (const plan of plans) {
    log(plan.skipped ? `${plan.identifier}: SKIP (${plan.skipped})` : `${plan.identifier}: blocked without a reason -> todo for its executor`);
  }
  if (!apply) {
    log(`dry-run: ${todo.length} to return to todo, ${plans.length - todo.length} skipped, nothing written`);
    return { plans, applied: 0 };
  }
  if (snapshotPath) {
    fs.writeFileSync(snapshotPath, JSON.stringify(todo.map((p) => p.before), null, 2), { mode: 0o600 });
    log(`snapshot written: ${snapshotPath}`);
  }
  let applied = 0;
  for (const batch of chunk(todo)) {
    const out = port.query(updateSql(batch));
    applied += out.length;
    if (out.length !== batch.length) log(`batch of ${batch.length}: ${out.length} updated (state changed since read)`);
  }
  log(`apply: ${applied} returned to todo; nobody woken, idle pickup takes them`);
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
  const snapshotPath = apply ? arg("--snapshot") ?? `ope-8904-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json` : null;
  try {
    const { plans, applied } = await run({ port: psqlPort(url), apply, only, snapshotPath });
    if (apply && applied !== plans.filter((p) => !p.skipped).length) return 1;
    return 0;
  } catch (err) {
    console.error(`unblock-reasonless: ${err instanceof Error ? err.message : "failed"}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
