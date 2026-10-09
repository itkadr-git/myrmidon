// OPE-6671: the trust-quarantine backfill is a DRY RUN. It must never change an
// issue; it only lists (activity_log) quarantined issues whose creation run is
// provably internal by the allowlist, so an operator can review and release
// them manually. External / unknown / unlisted provenance must not be listed.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_TAG = "0385_low_trust_internal_release_candidates";
const MIGRATION_FILE = `./migrations/${MIGRATION_TAG}.sql`;

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("low-trust release candidates migration (static checks)", () => {
  it("registers the migration last in the journal, after the latest rel migration", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const index = journal.entries.findIndex((e) => e.idx === 385);
    expect(journal.entries[index]?.tag).toBe(MIGRATION_TAG);
    expect(index).toBe(journal.entries.length - 1);
    expect(journal.entries[index - 1]?.idx).toBeLessThan(385);
  });

  it("is read-only for issues, allowlist-based, and has no denylist release", async () => {
    const sql = await readFile(fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)), "utf8");
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/UPDATE\s+"?issues"?/i);
    expect(code).not.toMatch(/DELETE\s+FROM/i);
    expect(code).toContain("'issue.low_trust_release_candidate'");
    expect(code).toContain("r.invocation_source IN ('assignment', 'automation', 'timer')");
    expect(code).toContain("r.company_id = i.company_id");
    expect(code).not.toContain("issue.interaction.respond");
    expect(code).not.toContain("issue.comment");
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
    invocationSource = "automation",
  ) {
    const [run] = await sql`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, invocation_source, context_snapshot)
      VALUES (${companyId}, ${agentId}, 'succeeded', ${invocationSource}, ${sql.json(contextSnapshot as never)})
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

  async function snapshotOf(issueId: string) {
    const [row] = await sql`SELECT source_trust AS st FROM issues WHERE id = ${issueId}`;
    return JSON.stringify(row.st);
  }

  it(
    "lists only provably internal quarantines, changes no issue, and replays clean",
    async () => {
      expect(sql).toBeTruthy();
      const { company, lead, worker } = await seedCompany("A");

      const internalRun = await seedRun(company.id, worker.id, {
        wakeReason: "execution_hold_cleared",
        wakeSource: "automation",
      });
      const candidate = await seedIssueWithQuarantine(company.id, "internal", internalRun.id, lead.id);

      const bad: Array<[string, string]> = [];
      const addBad = async (
        label: string,
        ctx: Record<string, unknown>,
        invocation = "automation",
      ) => {
        const run = await seedRun(company.id, worker.id, ctx, invocation);
        const issue = await seedIssueWithQuarantine(company.id, label, run.id, lead.id);
        bad.push([label, issue.id]);
      };
      await addBad("bound flag", { paperclipExternalChatExecutionBound: true });
      await addBad("interaction respond", { source: "issue.interaction.respond" });
      await addBad("comment wake", { source: "issue.comment" });
      await addBad("chat source", { source: "chat:telegram" });
      await addBad("webhook key", { webhookSource: "github" });
      await addBad("on_demand invocation", {}, "on_demand");
      const unknown = await seedIssueWithQuarantine(
        company.id,
        "unknown run",
        "00000000-0000-4000-8000-000000000000",
        lead.id,
      );
      bad.push(["unknown run", unknown.id]);

      const before = new Map<string, string>();
      for (const id of [candidate.id, ...bad.map(([, id]) => id)]) before.set(id, await snapshotOf(id));

      await applyMigration();

      const logged = await sql`
        SELECT entity_id FROM activity_log
        WHERE action = 'issue.low_trust_release_candidate' AND entity_type = 'issue'
      `;
      expect(logged.map((r) => r.entity_id)).toEqual([candidate.id]);

      // Dry run: no issue is modified, including the listed candidate.
      for (const [id, snap] of before) expect(await snapshotOf(id)).toBe(snap);
      const [{ n: released }] = await sql`
        SELECT count(*)::int AS n FROM activity_log WHERE action = 'issue.low_trust_released'
      `;
      expect(released).toBe(0);

      await applyMigration();
      const [{ n }] = await sql`
        SELECT count(*)::int AS n FROM activity_log WHERE action = 'issue.low_trust_release_candidate'
      `;
      expect(n).toBe(1);
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
