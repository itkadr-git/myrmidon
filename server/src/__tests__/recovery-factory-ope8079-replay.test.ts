import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issueRelations, issues } from "@myrmidon/db";
import {
  ISSUE_RECOVERY_ACTION_KINDS,
  type IssueRecoveryActionKind,
  type RecoveryFactoryRequest,
} from "@myrmidon/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { classifyOperatorAction } from "../services/recovery-factory/classify-disk-operator.js";

interface Ope8079FixtureItem {
  actionIndex: number;
  sourceIssue: string;
  sourceComment: string;
  sourceQuote: string;
  kind: IssueRecoveryActionKind;
  cause: string;
  slaMinutes: number;
  ownerRole: string;
  evidence: string;
}

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/recovery-factory-ope8079.json", import.meta.url), "utf8"),
) as Ope8079FixtureItem[];

const support = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !support.supported) {
  throw new Error(`OPE-8079 recovery replay requires PostgreSQL: ${support.reason}`);
}
const describePg = support.supported ? describe : describe.skip;

describePg("OPE-8079 recovery factory PostgreSQL replay", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("ope8079-recovery-");
    db = createDb(pg.connectionString);
  }, 120_000);

  afterAll(async () => {
    await pg?.cleanup();
  });

  async function setup() {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "OPE-8079 replay",
      issuePrefix: `RPL${companyId.slice(0, 7)}`,
    });

    const roles = Array.from(new Set(fixtures.map((f) => f.ownerRole)));
    const owners: Record<string, string> = {};

    for (const role of roles) {
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Owner for ${role}`,
        role: "engineer",
      });
      owners[role] = agentId;
    }

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "OPE-8079 root issue",
      issueNumber: 1,
      identifier: "OPE-8079",
    });

    return { companyId, sourceIssueId, owners };
  }

  function requestFor(
    fixture: Ope8079FixtureItem,
    context: Awaited<ReturnType<typeof setup>>,
  ): RecoveryFactoryRequest {
    const ownerId = context.owners[fixture.ownerRole];
    expect(ownerId, `Missing owner for role ${fixture.ownerRole}`).toBeDefined();

    const dedupeKey = `${fixture.kind}:${fixture.cause}:${fixture.sourceIssue}`;

    return {
      kind: fixture.kind,
      sourceIssueId: context.sourceIssueId,
      dedupeKey,
      owner: { agentId: ownerId },
      slaMinutes: fixture.slaMinutes,
      nextCheckAt: new Date(Date.now() + fixture.slaMinutes * 60_000).toISOString(),
      runbookRef: "OPE-8312#5.7",
      evidence: {
        actionIndex: fixture.actionIndex,
        sourceIssue: fixture.sourceIssue,
        sourceComment: fixture.sourceComment,
        sourceQuote: fixture.sourceQuote,
        cause: fixture.cause,
        ownerRole: fixture.ownerRole,
        detail: fixture.evidence,
      },
    };
  }

  it("verifies fixture source-grounding against OPE-8079 operator comment", () => {
    expect(fixtures).toHaveLength(9);
    const seenIndices = new Set<number>();
    const seenIssues = new Set<string>();

    for (const item of fixtures) {
      expect(item.actionIndex).toBeGreaterThanOrEqual(1);
      expect(item.actionIndex).toBeLessThanOrEqual(9);
      seenIndices.add(item.actionIndex);

      expect(item.sourceIssue).toMatch(/^OPE-\d+$/);
      seenIssues.add(item.sourceIssue);

      expect(item.sourceComment).toBe("461b3b78-8365-4ed7-9718-d174cf5aa956");
      expect(item.sourceQuote).toBeTruthy();
      expect(item.sourceQuote.length).toBeGreaterThan(10);
      expect(item.evidence).toBeTruthy();
      expect(item.ownerRole).toBeTruthy();
    }

    expect(seenIndices.size).toBe(9);
    expect(seenIssues.size).toBe(9);
  });

  it("verifies fixture produces 9 distinct typed recovery kinds, causes, and grounded SLAs", () => {
    const kinds = fixtures.map((f) => f.kind);
    const causes = fixtures.map((f) => f.cause);
    const dedupeKeys = fixtures.map((f) => `${f.kind}:${f.cause}:${f.sourceIssue}`);

    for (const kind of kinds) {
      expect(ISSUE_RECOVERY_ACTION_KINDS).toContain(kind);
    }

    // All 9 kinds are distinct
    expect(new Set(kinds).size).toBe(9);
    // All 9 causes are distinct
    expect(new Set(causes).size).toBe(9);
    // All 9 dedupe keys are distinct
    expect(new Set(dedupeKeys).size).toBe(9);

    // Grounded SLAs from OPE-8312 §5.7
    const expectedSlas: Record<string, number> = {
      workspace_myr_ws: 120,
      disk_space: 60,
      operator_action: 120,
      github_access: 60,
      branch_relay: 60,
      devbuild: 120,
      configuration_validation: 60,
      review_participant_restore: 60,
      ci_restart: 30,
    };

    for (const fixture of fixtures) {
      expect(fixture.slaMinutes).toBe(expectedSlas[fixture.kind]);
    }
  });

  it("PG replay: 9 signals produce 9 recovery issues with owner and SLA; second replay produces 0 new; no unassigned recovery", async () => {
    const context = await setup();
    const requests = fixtures.map((f) => requestFor(f, context));
    expect(requests).toHaveLength(9);

    const service = issueRecoveryActionService(db);
    const beforeTime = Date.now();

    // First replay: all 9 signals should be created
    const firstResults = await Promise.all(
      requests.map((req) => service.ensureRecoveryIssue(req)),
    );
    const afterTime = Date.now();

    expect(firstResults).toHaveLength(9);
    expect(firstResults.every((r) => r.outcome === "created")).toBe(true);

    const createdIssueIds = new Set(firstResults.map((r) => r.recoveryIssueId));
    const createdActionIds = new Set(firstResults.map((r) => r.recoveryActionId));
    expect(createdIssueIds.size).toBe(9);
    expect(createdActionIds.size).toBe(9);

    // Second replay: exact same 9 signals must yield 0 new issues and all 9 deduped
    const secondResults = await Promise.all(
      requests.map((req) => service.ensureRecoveryIssue(req)),
    );

    expect(secondResults).toHaveLength(9);
    expect(secondResults.filter((r) => r.outcome === "created")).toHaveLength(0);
    expect(secondResults.filter((r) => r.outcome === "deduped")).toHaveLength(9);

    // Every deduped result references the original recoveryIssueId and recoveryActionId
    for (let i = 0; i < 9; i++) {
      expect(secondResults[i].recoveryIssueId).toBe(firstResults[i].recoveryIssueId);
      expect(secondResults[i].recoveryActionId).toBe(firstResults[i].recoveryActionId);
    }

    // Database assertions: exactly 9 recovery actions in DB
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, context.companyId));
    expect(actionRows).toHaveLength(9);

    for (const action of actionRows) {
      const matchingFixture = fixtures.find((f) => action.dedupeKey.endsWith(f.sourceIssue));
      expect(matchingFixture).toBeDefined();

      const expectedOwnerId = context.owners[matchingFixture!.ownerRole];
      expect(action.ownerAgentId).toBe(expectedOwnerId);
      expect(action.slaDueAt).toBeInstanceOf(Date);
      expect(action.slaDueAt!.getTime()).toBeGreaterThanOrEqual(
        beforeTime + matchingFixture!.slaMinutes * 60_000,
      );
      expect(action.slaDueAt!.getTime()).toBeLessThanOrEqual(
        afterTime + matchingFixture!.slaMinutes * 60_000 + 5000,
      );
      expect(action.kind).toBe(matchingFixture!.kind);
    }

    // Database assertions: exactly 10 issues (1 root + 9 recovery issues)
    const issueRows = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, context.companyId));
    expect(issueRows).toHaveLength(10);

    const recoveryIssues = issueRows.filter((row) => row.id !== context.sourceIssueId);
    expect(recoveryIssues).toHaveLength(9);

    // "ни один recovery не без адресата"
    for (const recoveryIssue of recoveryIssues) {
      expect(recoveryIssue.assigneeAgentId).not.toBeNull();
      expect(recoveryIssue.originKind).toBe("recovery_factory");
      expect(recoveryIssue.status).toBe("todo");

      const isRecognizedOwner = Object.values(context.owners).includes(
        recoveryIssue.assigneeAgentId!,
      );
      expect(isRecognizedOwner).toBe(true);
    }

    // Relations: exactly 9 blocking relations linking recovery issues to source issue
    const relationRows = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, context.companyId));
    expect(relationRows).toHaveLength(9);
    for (const relation of relationRows) {
      expect(relation.type).toBe("blocks");
      expect(relation.relatedIssueId).toBe(context.sourceIssueId);
      expect(createdIssueIds.has(relation.issueId)).toBe(true);
    }
  });

  it("handles sequential replay safely without creating duplicates", async () => {
    const context = await setup();
    const service = issueRecoveryActionService(db);
    const requests = fixtures.map((f) => requestFor(f, context));

    for (const req of requests) {
      const res1 = await service.ensureRecoveryIssue(req);
      expect(res1.outcome).toBe("created");
      const res2 = await service.ensureRecoveryIssue(req);
      expect(res2.outcome).toBe("deduped");
      expect(res2.recoveryIssueId).toBe(res1.recoveryIssueId);
    }

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, context.companyId));
    expect(actionRows).toHaveLength(9);
  });

  it("verifies R5 classifier compatibility with operator signals from OPE-8079", () => {
    // The operator action signals from OPE-8079 can also be ingested as operator signals
    for (const fixture of fixtures) {
      const classified = classifyOperatorAction({
        message: fixture.sourceQuote,
      });
      // Classifier either identifies an operator cause or the signal is typed directly
      if (classified) {
        expect(classified.kind).toBe("operator_action");
        expect(classified.scope).toBe("operator");
      }
    }
  });
});
