import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  closeRegisteredClients,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runLegacyBlockedDryRun } from "../../../scripts/myrmidon/legacy-blocked/dry-run.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres legacy blocked dry-run test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("legacy blocked dry-run postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-blocked-dry-run-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) {
      await closeRegisteredClients(tempDb.connectionString);
      await tempDb.cleanup();
    }
  });

  async function snapshotTables() {
    return {
      companies: await db.select().from(companies).orderBy(asc(companies.id)),
      agents: await db.select().from(agents).orderBy(asc(agents.id)),
      issues: await db.select().from(issues).orderBy(asc(issues.id)),
      issueRelations: await db.select().from(issueRelations).orderBy(asc(issueRelations.id)),
      issueThreadInteractions: await db
        .select()
        .from(issueThreadInteractions)
        .orderBy(asc(issueThreadInteractions.id)),
      issueComments: await db
        .select()
        .from(issueComments)
        .orderBy(asc(issueComments.id)),
    };
  }

  function hashSnapshot(snapshot: unknown): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  it("orchestrates inventory -> classify -> report to file while leaving database unchanged (hash verified)", async () => {
    const companyId = randomUUID();
    const eligibleDepId = randomUUID();
    const eligibleRecId = randomUUID();
    const eligibleDecisionId = randomUUID();
    const eligibleUnknownId = randomUUID();
    const agentId = randomUUID();

    const openBlockedId = randomUUID();
    const openBlockerId = randomUUID();
    const pendingInteractionId = randomUUID();
    const metadataIssueId = randomUUID();
    const resolvedBlockerId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Legacy blocked dry-run fixture",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Dependency test agent",
    });

    await db.insert(issues).values([
      // 4 eligible legacy-blocked issues
      {
        id: eligibleDepId,
        companyId,
        title: "Eligible dependency blocked issue",
        status: "blocked",
        assigneeAgentId: agentId,
      },
      {
        id: eligibleRecId,
        companyId,
        title: "Eligible recovery blocked issue",
        status: "blocked",
        assigneeUserId: "user-rec-1",
      },
      {
        id: eligibleDecisionId,
        companyId,
        title: "Eligible human decision blocked issue",
        status: "blocked",
      },
      {
        id: eligibleUnknownId,
        companyId,
        title: "Eligible unknown blocked issue",
        status: "blocked",
      },
      // Non-eligible / active blocker / metadata issues
      {
        id: openBlockedId,
        companyId,
        title: "Issue with open blocker",
        status: "blocked",
      },
      {
        id: openBlockerId,
        companyId,
        title: "Active blocker issue",
        status: "in_progress",
      },
      {
        id: resolvedBlockerId,
        companyId,
        title: "Resolved blocker issue",
        status: "done",
      },
      {
        id: pendingInteractionId,
        companyId,
        title: "Issue with pending interaction",
        status: "blocked",
      },
      {
        id: metadataIssueId,
        companyId,
        title: "Blocked issue with modern metadata",
        status: "blocked",
        blockerMetadata: {
          blockReason: "external_wait",
          owner: { userId: randomUUID() },
          externalRef: "fixture:legacy-blocked-dry-run",
          nextCheckAt: "2026-10-26T00:00:00.000Z",
          timeoutAt: "2026-10-27T00:00:00.000Z",
          escalationPolicy: "none",
        },
      },
    ]);

    // Comments providing facts for classification
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: eligibleDepId,
        body: "Execution is blocked by upstream task OPE-500",
      },
      {
        companyId,
        issueId: eligibleRecId,
        body: "Initiating recovery retry after process termination",
      },
      {
        companyId,
        issueId: eligibleDecisionId,
        body: "Awaiting need decision from product manager before moving forward",
      },
    ]);

    // Open blocker relation
    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: openBlockerId,
        relatedIssueId: openBlockedId,
        type: "blocks",
      },
      {
        companyId,
        issueId: resolvedBlockerId,
        relatedIssueId: eligibleDecisionId,
        type: "blocks",
      },
    ]);

    // Pending interaction
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: pendingInteractionId,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, prompt: "Need user confirmation" },
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pg-dry-run-"));
    const outputFile = path.join(tmpDir, "report.json");

    try {
      // 1. Snapshot database state and compute SHA-256 hash before dry-run
      const before = await snapshotTables();
      const hashBefore = hashSnapshot(before);

      // 2. Execute dry-run
      const { report, outputFilePath, content } = await runLegacyBlockedDryRun(db, {
        outputFile,
        format: "json",
      });

      // 3. Snapshot database state and compute SHA-256 hash after dry-run
      const after = await snapshotTables();
      const hashAfter = hashSnapshot(after);

      // 4. Assert database is 100% unchanged (hash equality and deep equality)
      expect(hashAfter).toBe(hashBefore);
      expect(after).toEqual(before);

      // 5. Assert report file exists and content matches
      expect(outputFilePath).toBe(outputFile);
      const fileContent = await fs.readFile(outputFilePath, "utf-8");
      expect(fileContent).toBe(content);

      const parsed = JSON.parse(fileContent);
      expect(parsed.rows).toHaveLength(4);

      // 6. Assert reconciliation report matches expected classes and owners
      expect(report.rows).toHaveLength(4);
      expect(report.totals.dependency).toBe(1);
      expect(report.totals.recovery).toBe(1);
      expect(report.totals.human_decision).toBe(1);
      expect(report.totals.unknown).toBe(1);

      const depRow = report.rows.find((r) => r.issueId === eligibleDepId);
      expect(depRow?.class).toBe("dependency");
      expect(depRow?.proposedOwner).toBe(agentId);

      const recRow = report.rows.find((r) => r.issueId === eligibleRecId);
      expect(recRow?.class).toBe("recovery");
      expect(recRow?.proposedOwner).toBe("user-rec-1");

      const decRow = report.rows.find((r) => r.issueId === eligibleDecisionId);
      expect(decRow?.class).toBe("human_decision");
      expect(decRow?.proposedOwner).toBe("legacy-blocked-owner");

      const unkRow = report.rows.find((r) => r.issueId === eligibleUnknownId);
      expect(unkRow?.class).toBe("unknown");
      expect(report.unknown).toHaveLength(1);
      expect(report.unknown[0].issueId).toBe(eligibleUnknownId);

      expect(report.lost).toHaveLength(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
