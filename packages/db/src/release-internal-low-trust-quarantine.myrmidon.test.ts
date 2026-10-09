// OPE-6671: the trust-quarantine backfill must release exactly the issues whose
// creation run proves internal provenance (same company, run agent in company,
// no external-input marker) and leave real quarantines untouched. Static checks
// pin the migration file and journal entry; the embedded-Postgres half applies
// the statement on seeded rows and asserts the release/no-release split plus
// replay idempotency.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_TAG = "0382_release_internal_low_trust_quarantine";
const MIGRATION_FILE = `./migrations/${MIGRATION_TAG}.sql`;

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("internal low-trust quarantine release migration (static checks)", () => {
  it("registers the migration in the journal immediately after 0381", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const index = journal.entries.findIndex((e) => e.idx === 382);
    expect(journal.entries[index]?.tag).toBe(MIGRATION_TAG);
    expect(journal.entries[index - 1]?.idx).toBe(381);
    expect(index).toBe(journal.entries.length - 1);
  });

  it("mirrors the app-side external-marker denylist and keeps the audit row", async () => {
    const sql = await readFile(fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)), "utf8");
    // Candidate set: quarantined low-trust issues only.
    expect(sql).toContain("'preset' = 'low_trust_review'");
    expect(sql).toContain("'disposition' = 'quarantined'");
    // Same-company run + run agent in company (fail closed on unknown/foreign).
    expect(sql).toContain("AND r.company_id = c.company_id");
    expect(sql).toContain("AND a.company_id = c.company_id");
    // External markers kept quarantined (mirror of isExternalInputRunProvenance).
    for (const marker of [
      "paperclipExternalChatExecutionBound",
      "externalChatExecutionBound",
      "chat:%",
      "webhook",
      "telegram",
      "whatsapp",
    ])
      expect(sql).toContain(marker);
    // Release is recorded in the promotion shape and journalled.
    expect(sql).toContain("'disposition', 'promoted'");
    expect(sql).toContain("'promotedByActorType', 'system'");
    expect(sql).toContain("INSERT INTO \"activity_log\"");
    expect(sql).toContain("'issue.low_trust_released'");
  });
});

describeEmbeddedPostgres("internal low-trust quarantine release migration (behaviour)", () => {
  let sql!: postgres.Sql;

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("ope-6671-release-");
    cleanups.push(database.cleanup);
    sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });
  }, 120_000);

  async function seedCompany(suffix: string) {
    const [company] = await sql`
      INSERT INTO companies (name, issue_prefix)
      VALUES (${`OPE-6671 ${suffix}`}, ${`REL${suffix}`})
      RETURNING id
    `;
    const [lead] = await sql`
      INSERT INTO agents (company_id, name, role)
      VALUES (${company.id}, 'lead', 'lead')
      RETURNING id
    `;
    const [worker] = await sql`
      INSERT INTO agents (company_id, name, role)
      VALUES (${company.id}, 'worker', 'engineer')
      RETURNING id
    `;
    return { company, lead, worker };
  }

  async function seedIssueWithQuarantine(
    companyId: string,
    title: string,
    sourceRunId: string,
    sourceAgentId: string,
  ) {
    const [issue] = await sql`
      INSERT INTO issues (company_id, title, status, priority, source_trust)
      VALUES (
        ${companyId},
        ${title},
        'todo',
        'high',
        ${sql.json({
          preset: "low_trust_review",
          disposition: "quarantined",
          sourceIssueId: companyId,
          sourceRunId,
          sourceAgentId,
        } as never)}
      )
      RETURNING id
    `;
    return issue;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    contextSnapshot: Record<string, unknown>,
  ) {
    const [run] = await sql`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, invocation_source, context_snapshot)
      VALUES (${companyId}, ${agentId}, 'succeeded', 'automation', ${sql.json(contextSnapshot as never)})
      RETURNING id
    `;
    return run;
  }

  async function applyMigration() {
    const migrationSql = await readFile(
      fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    await sql.unsafe(migrationSql);
  }

  async function disposition(issueId: string) {
    const [row] = await sql`SELECT source_trust ->> 'disposition' AS disposition FROM issues WHERE id = ${issueId}`;
    return row.disposition as string;
  }

  it(
    "releases internally-created quarantines, keeps external ones, logs each release, and replays clean",
    async () => {
      expect(sql).toBeTruthy();
      const { company, lead, worker } = await seedCompany("A");

      // 1. False positive: created from another internal agent's same-company
      // automation run with no external markers (the OPE-6671 production case).
      const internalRun = await seedRun(company.id, worker.id, {
        wakeReason: "execution_hold_cleared",
      });
      const falsePositive = await seedIssueWithQuarantine(
        company.id,
        "internal delegation",
        internalRun.id,
        lead.id,
      );

      // 2. Genuine external input: same company, but the creation run carries
      // the external-chat execution-bound marker.
      const externalRun = await seedRun(company.id, worker.id, {
        paperclipExternalChatExecutionBound: true,
      });
      const externalQuarantine = await seedIssueWithQuarantine(
        company.id,
        "external input",
        externalRun.id,
        lead.id,
      );

      // 3. No releaseable provenance: sourceRunId points at a run that does not
      // exist (fail closed — the quarantine decision cannot be re-derived).
      const unknownRunIssue = await seedIssueWithQuarantine(
        company.id,
        "unknown run",
        "00000000-0000-4000-8000-000000000000",
        lead.id,
      );

      await applyMigration();

      expect(await disposition(falsePositive.id)).toBe("promoted");
      expect(await disposition(externalQuarantine.id)).toBe("quarantined");
      expect(await disposition(unknownRunIssue.id)).toBe("quarantined");

      const [promoted] = await sql`
        SELECT source_trust ->> 'promotedByActorType' AS actor_type,
          source_trust ->> 'promotedByActorId' AS actor_id
        FROM issues WHERE id = ${falsePositive.id}
      `;
      expect(promoted.actor_type).toBe("system");
      expect(promoted.actor_id).toBe(`migration:${MIGRATION_TAG}`);

      const logged = await sql`
        SELECT entity_id FROM activity_log
        WHERE action = 'issue.low_trust_released' AND entity_type = 'issue'
      `;
      expect(logged.map((r) => r.entity_id)).toEqual([falsePositive.id]);

      // Replay touches nothing: released rows left the candidate set.
      await applyMigration();
      const afterReplay = await sql`
        SELECT count(*)::int AS n FROM activity_log WHERE action = 'issue.low_trust_released'
      `;
      expect(afterReplay[0].n).toBe(1);
      expect(await disposition(falsePositive.id)).toBe("promoted");
    },
    90_000,
  );

  it("does not touch promoted or non-quarantined rows", async () => {
    const { company, lead } = await seedCompany("B");
    const run = await seedRun(company.id, lead.id, {});
    const [alreadyPromoted] = await sql`
      INSERT INTO issues (company_id, title, status, priority, source_trust)
      VALUES (
        ${company.id}, 'already promoted', 'todo', 'high',
        ${sql.json({
          preset: "low_trust_review",
          disposition: "promoted",
          sourceIssueId: company.id,
          sourceRunId: run.id,
          sourceAgentId: lead.id,
          promotedFrom: { artifactKind: "issue", artifactId: "x", issueId: company.id },
          promotedByActorType: "user",
          promotedByActorId: "board-user",
          promotedAt: "2026-10-09T00:00:00.000Z",
        } as never)}
      )
      RETURNING id, source_trust ->> 'promotedByActorId' AS promoted_by
    `;
    await applyMigration();
    const [after] = await sql`
      SELECT source_trust ->> 'promotedByActorId' AS promoted_by FROM issues WHERE id = ${alreadyPromoted.id}
    `;
    expect(after.promoted_by).toBe("board-user");
  });
});
