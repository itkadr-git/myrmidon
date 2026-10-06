// myrmidon(HEARTBEAT-POLL): regression guard for the run-ownership probe.
//
// server/src/services/conversation-continuation.ts (getConversationOwnershipBlocker)
// asks, on every wake through getExecutionBlocker: "does this task still have a
// terminal legacy run of a conversation adapter that may own a process or an
// environment lease?". The predicate carries company + runtime_mode + the run's
// issue reference + four terminal statuses, with an OR over the JSON evidence
// and a correlated exists over heartbeat_run_events.
//
// The company + terminal-status pair is already index-served, so the statement
// never had to read the whole table: the cost was the FILTER. Without an index
// for the issue reference the planner can only narrow to every terminal run of
// the company, then evaluate the OR over the JSON evidence and the correlated
// exists for each of them. On a busy instance that slice is most of the table,
// and the statement cost seconds per call.
//
// The guard seeds exactly that shape — one company with a large terminal legacy
// slice and one task inside it — and proves the fix:
//   - the companion index of migration 0301 exists;
//   - with it the issue-reference equality is an index condition, the statement
//     reads a handful of rows and never sequentially scans heartbeat_runs;
//   - without it the same statement falls back to the company + status slice,
//     filters thousands of rows away and costs an order of magnitude more;
//   - the migration statement is idempotent.
//
// See docs/myrmidon/DIVERGENCE.md.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

/** Terminal legacy runs of the probed company: the slice the probe used to filter. */
const TERMINAL_SLICE = 10_000;

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

/** The probe, verbatim: same filters, same OR, same exists, same ORDER BY. */
const OWNERSHIP_PROBE = `
  SELECT hr.id,
         exists (select 1 from environment_leases el
                 where el.company_id = hr.company_id
                   and el.heartbeat_run_id = hr.id
                   and (el.released_at is null
                     or el.status = 'pending_cleanup'
                     or el.cleanup_status = 'failed')) as active_lease
  FROM heartbeat_runs hr
  WHERE hr.company_id = $1
    AND hr.runtime_mode = 'legacy'
    AND (hr.runner_profile_json->'adapterDispatch'->>'adapterType' IN (
          'claude_local', 'codex_local', 'cursor', 'gemini_local', 'opencode_local',
          'pi_local', 'grok_local', 'kimi_local', 'hermes_local', 'hermes_gateway')
      OR hr.result_json->>'conversationContinuation' = 'continue_conversation_v1'
      OR exists (select 1 from heartbeat_run_events e
                 where e.company_id = hr.company_id
                   and e.run_id = hr.id
                   and e.event_type = 'adapter.invoke'
                   and e.payload->>'adapterType' IN (
                     'claude_local', 'codex_local', 'cursor', 'gemini_local', 'opencode_local',
                     'pi_local', 'grok_local', 'kimi_local', 'hermes_local', 'hermes_gateway')))
    AND coalesce(hr.native_issue_id::text, hr.context_snapshot->>'issueId') = $2
    AND hr.status IN ('failed', 'timed_out', 'interrupted', 'cancelled')
    AND (hr.process_pid is not null
      or hr.process_group_id is not null
      or exists (select 1 from environment_leases el2
                 where el2.company_id = hr.company_id
                   and el2.heartbeat_run_id = hr.id
                   and (el2.released_at is null
                     or el2.status = 'pending_cleanup'
                     or el2.cleanup_status = 'failed')))
  ORDER BY hr.created_at DESC, hr.id DESC
`;

const INDEX_NAME = "heartbeat_runs_company_legacy_terminal_issue_idx";
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "heartbeat_runs" USING btree ("company_id",(coalesce("native_issue_id"::text, "context_snapshot" ->> 'issueId')),"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "runtime_mode" = 'legacy' and "status" in ('failed', 'timed_out', 'interrupted', 'cancelled')`;

function planText(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => String(Object.values(row)[0])).join("\n");
}

function executionMs(text: string): number {
  const match = text.match(/Execution Time:\s*([\d.]+)\s*ms/);
  return match ? Number.parseFloat(match[1]!) : Number.NaN;
}

/** Rows the statement's filter rejected: how much filter work it did. */
function rowsRemovedByFilter(text: string): number {
  const matches = [...text.matchAll(/Rows Removed by Filter:\s*(\d+)/g)];
  return matches.reduce((sum, match) => sum + Number.parseInt(match[1]!, 10), 0);
}

async function explain(
  sql: ReturnType<typeof postgres>,
  companyId: string,
  issueId: string,
): Promise<{ text: string; ms: number }> {
  const rows = await sql.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${OWNERSHIP_PROBE}`,
    [companyId, issueId],
  );
  const text = planText(rows);
  return { text, ms: executionMs(text) };
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("heartbeat run-ownership probe index migration", () => {
  it("migrates the companion index and keeps the probe off the terminal-run slice", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap0301-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    // 1) The migration is in the applied history and its index exists.
    const idx = await sql`
      SELECT indexname FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;
    expect(idx.map((row) => row.indexname)).toEqual([INDEX_NAME]);

    // 2) Seed the production shape: one company whose terminal legacy slice is
    // large, one task inside that slice, and a handful of other companies.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await sql`
      INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      VALUES (${companyId}, 'Ownership seed target', 'OSX', false, 'responsible-user')
    `;
    await sql`
      INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      SELECT gen_random_uuid(), 'Ownership filler ' || i, 'OF' || lpad(i::text, 4, '0'), false, 'responsible-user'
      FROM generate_series(1, 19) i
    `;
    await sql`
      INSERT INTO agents (id, company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      VALUES (${agentId}, ${companyId}, 'Owner', 'engineer', 'active', 'codex_local', '{}'::jsonb,
              '{"heartbeat":{"wakeOnDemand":true,"maxConcurrentRuns":1}}'::jsonb, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO agents (id, company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      SELECT gen_random_uuid(), c.id, 'Filler agent', 'engineer', 'active', 'codex_local', '{}'::jsonb,
             '{"heartbeat":{"wakeOnDemand":true,"maxConcurrentRuns":1}}'::jsonb, '{}'::jsonb
      FROM companies c WHERE c.id <> ${companyId}
    `;
    await sql`
      INSERT INTO issues (id, company_id, title) VALUES (${issueId}, ${companyId}, 'Ownership seed task')
    `;
    await sql`
      INSERT INTO issues (id, company_id, title)
      SELECT gen_random_uuid(), c.id, 'Filler task' FROM companies c WHERE c.id <> ${companyId}
    `;
    // The probed company: a large legacy-terminal slice, every row of it bound to
    // its own random issue reference, so no row of the slice can match the task.
    await sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, runtime_mode, created_at,
                                  native_issue_id, context_snapshot, runner_profile_json)
      SELECT gen_random_uuid(), ${companyId}::uuid, ${agentId}::uuid,
             (ARRAY['failed','timed_out','interrupted','cancelled'])[1 + (g % 4)],
             'legacy',
             now() - (g || ' seconds')::interval,
             gen_random_uuid(),
             jsonb_build_object('issueId', gen_random_uuid()::text),
             jsonb_build_object('adapterDispatch', jsonb_build_object('adapterType', 'codex_local'))
      FROM generate_series(1, ${TERMINAL_SLICE}) g
    `;
    // Every other company: a small terminal slice of its own.
    await sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, runtime_mode, created_at,
                                  native_issue_id, context_snapshot, runner_profile_json)
      SELECT gen_random_uuid(), a.company_id, a.id, 'failed', 'legacy',
             now() - (g || ' minutes')::interval,
             gen_random_uuid(), jsonb_build_object('issueId', gen_random_uuid()::text),
             jsonb_build_object('adapterDispatch', jsonb_build_object('adapterType', 'codex_local'))
      FROM agents a CROSS JOIN generate_series(1, 100) g
      WHERE a.company_id <> ${companyId}
    `;
    // The probed task: three terminal legacy runs that do paper over the adapter
    // evidence (two through the profile, one only through a run event), with a
    // live process and a held environment lease.
    await sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, runtime_mode, created_at,
                                  context_snapshot, runner_profile_json, process_pid, process_started_at)
      VALUES
        (gen_random_uuid(), ${companyId}, ${agentId}, 'interrupted', 'legacy', now() - interval '3 minutes',
         jsonb_build_object('issueId', ${issueId}::text),
         jsonb_build_object('adapterDispatch', jsonb_build_object('adapterType', 'codex_local')), 4242, now() - interval '3 minutes'),
        (gen_random_uuid(), ${companyId}, ${agentId}, 'failed', 'legacy', now() - interval '2 minutes',
         jsonb_build_object('issueId', ${issueId}::text),
         '{"conversationContinuation":"continue_conversation_v1"}'::jsonb, 4243, now() - interval '2 minutes'),
        (gen_random_uuid(), ${companyId}, ${agentId}, 'cancelled', 'legacy', now() - interval '1 minute',
         jsonb_build_object('issueId', ${issueId}::text), '{}'::jsonb, null, null)
    `;
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, payload)
      SELECT ${companyId}::uuid, hr.id, ${agentId}::uuid, 1, 'adapter.invoke',
             jsonb_build_object('adapterType', 'codex_local')
      FROM heartbeat_runs hr
      WHERE hr.company_id = ${companyId} AND hr.status = 'cancelled'
    `;
    await sql`ANALYZE heartbeat_runs`;
    await sql`ANALYZE heartbeat_run_events`;

    // 3) With the migration's index the issue-reference equality is an index
    // condition: a handful of rows, no sequential scan, no filter sweep.
    const indexed = await explain(sql, companyId, issueId);
    expect(indexed.text).toContain(INDEX_NAME);
    expect(indexed.text).toMatch(/COALESCE\(\(native_issue_id\)::text/);
    expect(indexed.text).not.toMatch(/Seq Scan on heartbeat_runs/);
    expect(rowsRemovedByFilter(indexed.text)).toBeLessThan(50);

    // 4) Without the companion index the same statement can only narrow to the
    // company + terminal-status slice: it filters thousands of rows away and
    // costs an order of magnitude more. That is the measurement the change is
    // judged on. The index is restored right after.
    await sql.unsafe(`DROP INDEX "${INDEX_NAME}"`);
    const unindexed = await explain(sql, companyId, issueId);
    expect(unindexed.text).not.toContain(INDEX_NAME);
    expect(unindexed.text).not.toMatch(/Seq Scan on heartbeat_runs/);
    expect(rowsRemovedByFilter(unindexed.text)).toBeGreaterThan(1_000);
    expect(unindexed.ms / indexed.ms).toBeGreaterThan(3);
    console.log(
      `[heartbeat-poll] probe over ${TERMINAL_SLICE} terminal runs of one company: ` +
        `without the index ${unindexed.ms.toFixed(3)} ms ` +
        `(filter rejected ${rowsRemovedByFilter(unindexed.text)} rows), ` +
        `with the index ${indexed.ms.toFixed(3)} ms ` +
        `(filter rejected ${rowsRemovedByFilter(indexed.text)} rows)`,
    );

    // 5) Idempotency: re-applying the migration statement is a no-op.
    await sql.unsafe(CREATE_INDEX);
    const restored = await sql`
      SELECT indexname FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;
    expect(restored.length).toBe(1);
  }, 300_000);
});