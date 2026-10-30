#!/usr/bin/env node
// OPE-8998: one-time data migration. Closes agent_wakeup_requests that outlived
// their run, so that nothing reads them as a wake in flight:
//   status `claimed` with no live run (every run bound to it is terminal, or
//   there is none)                                   -> `failed`
//   status `queued` review-admission seed without a run (key
//   `issue-review-admission:%`)                       -> `coalesced`
// Live run = heartbeat_runs.status in queued, running, scheduled_retry.
// Left alone: rows younger than --min-age-min (default 60), the durable intents
// of native status commits (requested_by_actor_id `native-status-committer` or
// `native-status-wake-dispatch:%`, recovered by their own sweep), and any other
// `queued` row (reported in the plan, never changed).
//
// Usage:
//   DATABASE_URL=postgres://... node close-orphan-wakeup-requests.mjs --dry-run
//   DATABASE_URL=postgres://... node close-orphan-wakeup-requests.mjs --apply [--snapshot FILE] [--min-age-min N]
// --dry-run reads and prints the plan, it never writes (not even the snapshot).
// --apply first writes a JSON snapshot of every row it will change, then updates
// in batches, each row guarded by the status it was read with.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { psqlPort } from "./escalate-human-reviews-to-agents.mjs";

export const MESSAGE = "closed by the OPE-8998 orphan wake-request migration";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: the target status of an orphan row, or null when it is left alone. */
export function targetStatus(row) {
  if (row.status === "claimed") return "failed";
  if (row.status === "queued" && String(row.idempotency_key ?? "").startsWith("issue-review-admission:")) return "coalesced";
  return null;
}

export function selectSql(minAgeMin) {
  const age = Number(minAgeMin);
  if (!Number.isInteger(age) || age < 0) throw new Error("bad --min-age-min");
  return `select coalesce(json_agg(t), '[]'::json) from (
    select w.id, w.company_id, w.agent_id, w.status, w.reason, w.idempotency_key, w.requested_at, w.claimed_at, w.run_id, w.error
    from agent_wakeup_requests w
    where w.status in ('claimed', 'queued')
      and w.created_at < now() - interval '${age} minutes'
      and coalesce(w.requested_by_actor_id, '') <> 'native-status-committer'
      and coalesce(w.requested_by_actor_id, '') not like 'native-status-wake-dispatch:%'
      and not exists (select 1 from heartbeat_runs r
                      where r.wakeup_request_id = w.id and r.status in ('queued', 'running', 'scheduled_retry'))
    order by w.created_at) t`;
}

export function updateSql(ids, status) {
  if (!ids.length || !ids.every((v) => UUID.test(v))) throw new Error("bad uuid in plan");
  const from = status === "failed" ? "claimed" : "queued";
  const error = status === "failed" ? `, error = coalesce(error, '${MESSAGE}')` : "";
  return `update agent_wakeup_requests set status = '${status}', finished_at = coalesce(finished_at, now()),
    updated_at = now()${error}
    where id in (${ids.map((i) => `'${i}'`).join(",")}) and status = '${from}'
      and not exists (select 1 from heartbeat_runs r where r.wakeup_request_id = agent_wakeup_requests.id
                      and r.status in ('queued', 'running', 'scheduled_retry'))
    returning id`;
}

export function run({ port, apply, snapshotPath, minAgeMin = 60, batch = 100, log = console.log }) {
  const rows = port.query(selectSql(minAgeMin));
  const plan = { failed: [], coalesced: [], untouched: [] };
  for (const row of rows) (plan[targetStatus(row) ?? "untouched"] ??= []).push(row);
  log(`claimed -> failed: ${plan.failed.length}`);
  log(`queued review-admission -> coalesced: ${plan.coalesced.length}`);
  log(`queued, left alone: ${plan.untouched.length}`);
  if (!apply) {
    log("dry-run: nothing written");
    return { plan, applied: 0 };
  }
  const todo = [...plan.failed, ...plan.coalesced];
  if (snapshotPath) {
    fs.writeFileSync(snapshotPath, JSON.stringify(todo, null, 2));
    log(`snapshot written: ${snapshotPath}`);
  }
  let applied = 0;
  for (const [status, list] of [["failed", plan.failed], ["coalesced", plan.coalesced]]) {
    for (let i = 0; i < list.length; i += batch) {
      const ids = list.slice(i, i + batch).map((r) => r.id);
      applied += port.query(`with u as (${updateSql(ids, status)}) select coalesce(json_agg(u), '[]'::json) from u`).length;
    }
  }
  log(`apply: ${applied} of ${todo.length} closed`);
  return { plan, applied };
}

async function main(argv) {
  const apply = argv.includes("--apply");
  if (apply === argv.includes("--dry-run")) {
    console.error("exactly one of --dry-run / --apply is required");
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const snapshotPath = apply ? arg("--snapshot") ?? `ope-8998-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json` : null;
  try {
    run({ port: psqlPort(url), apply, snapshotPath, minAgeMin: arg("--min-age-min") ?? 60 });
    return 0;
  } catch (err) {
    console.error(`close-orphan-wakeup-requests: ${err instanceof Error ? err.message : "failed"}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
