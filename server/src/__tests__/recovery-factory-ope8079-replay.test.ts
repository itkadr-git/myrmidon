import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issueRelations, issues } from "@myrmidon/db";
import {
  ISSUE_RECOVERY_ACTION_KINDS,
  type IssueRecoveryActionKind,
  type RecoveryFactoryRequest,
  RECOVERY_SLA_MINUTES_BY_KIND,
  buildRecoveryDedupeKey,
} from "@myrmidon/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import {
  classifyOperatorAction,
  type RecoverySignal,
} from "../services/recovery-factory/classify-disk-operator.js";
import {
  resolveRecoveryOwner,
  type RecoveryOwnerCandidate,
} from "../services/recovery-factory/resolve-owner.js";

interface FixtureItem {
  actionIndex: number;
  sourceIssue: string;
  sourceDescription: string;
  signal: {
    issueId: string;
    action: string;
    message: string;
    context?: Record<string, unknown>;
  };
  expectedClassification: {
    kind: IssueRecoveryActionKind;
    cause: string;
    scope: string;
  };
  policy: {
    role: string;
    slaMinutes: number;
  };
}

const support = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !support.supported) {
  throw new Error(`Recovery factory replay requires PostgreSQL: ${support.reason}`);
}
const describePg = support.supported ? describe : describe.skip;

describePg("recovery-factory-ope8079-replay PostgreSQL acceptance", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let fixtures: FixtureItem[];

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("ope8079-replay-");
    db = createDb(pg.connectionString);

    const fixtureContent = await readFile(
      new URL("./fixtures/recovery-factory-ope8079.json", import.meta.url),
      "utf-8",
    );
    fixtures = JSON.parse(fixtureContent);
  }, 120_000);

  afterAll(async () => {
    await pg?.cleanup();
  });

  it("verifies that all 9 OPE-8079 operator actions map to distinct source issues and valid signals", () => {
    expect(fixtures).toHaveLength(9);
    const seenIndices = new Set<number>();
    const seenIssues = new Set<string>();

    for (const item of fixtures) {
      expect(item.actionIndex).toBeGreaterThanOrEqual(1);
      expect(item.actionIndex).toBeLessThanOrEqual(9);
      seenIndices.add(item.actionIndex);

      seenIssues.add(item.sourceIssue);
      expect(item.sourceDescription.length).toBeGreaterThan(15);
      expect(item.sourceDescription).toContain(item.sourceIssue);

      // Verify signal consistency
      expect(item.signal.issueId).toBe(item.sourceIssue);
      expect(item.signal.action).toBeDefined();
      expect(item.signal.message.length).toBeGreaterThan(10);
    }

    expect(seenIndices.size).toBe(9);
    expect(seenIssues.size).toBe(9);
  });

  it("demonstrates end-to-end behavioral path: signal → production R5 classifier → production policy §5.7 → request → PostgreSQL", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "OPE-8079 Root Recovery Replay",
      issuePrefix: "REC8079",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Root issue OPE-8079 (umbrella 9 operator actions)",
      identifier: "REC8079-1",
      issueNumber: 1,
      status: "in_progress",
      priority: "high",
    });

    // Create candidates representing domain agents for owner resolution (OPE-8312 §5.7)
    const operatorAgentId = randomUUID();
    await db.insert(agents).values({
      id: operatorAgentId,
      companyId,
      name: "Operator Agent",
      role: "operator",
      status: "active",
      adapterType: "hermes_gateway",
    });

    const ownerCandidates: RecoveryOwnerCandidate[] = [
      { agentId: operatorAgentId, role: "operator", status: "active" },
    ];

    const service = issueRecoveryActionService(db);
    const createdActionIds: string[] = [];
    const createdRecoveryIssueIds: string[] = [];
    const generatedRequests: RecoveryFactoryRequest[] = [];

    // --- PHASE 1: First replay pass (9 operator actions -> 9 typed recovery issues) ---
    const startTime = Date.now();

    for (const item of fixtures) {
      // 1. Production R5 classifier takes signal -> produces { kind, cause, scope }
      const classification = classifyOperatorAction(item.signal);
      expect(classification).not.toBeNull();
      expect(classification!.kind).toBe("operator_action");
      expect(classification!.cause).toBe(item.expectedClassification.cause);
      expect(classification!.scope).toBe("operator");
      expect(ISSUE_RECOVERY_ACTION_KINDS).toContain(classification!.kind);

      // 2. Production policy resolver resolves owner and SLA for kind (OPE-8312 §5.7 via resolveRecoveryOwner)
      const policyResolution = resolveRecoveryOwner({
        kind: classification!.kind,
        candidates: ownerCandidates,
      });
      expect("agentId" in policyResolution.owner).toBe(true);
      expect(policyResolution.owner).toEqual({ agentId: operatorAgentId });
      expect(policyResolution.slaMinutes).toBe(RECOVERY_SLA_MINUTES_BY_KIND.operator_action);
      expect(policyResolution.slaMinutes).toBe(120);

      // 3. Construct request from classification + policy (using standard cyrb128 dedupeKey)
      const dedupeKey = buildRecoveryDedupeKey({
        kind: classification!.kind,
        cause: classification!.cause,
        scope: `${classification!.scope}:${item.signal.issueId}`,
      });

      const nextCheckAt = new Date(Date.now() + policyResolution.slaMinutes * 60_000).toISOString();
      const request: RecoveryFactoryRequest = {
        kind: classification!.kind,
        dedupeKey,
        sourceIssueId,
        owner: policyResolution.owner,
        slaMinutes: policyResolution.slaMinutes,
        nextCheckAt,
        runbookRef: `runbooks/recovery/${classification!.kind}.md`,
        evidence: {
          actionIndex: item.actionIndex,
          sourceIssue: item.sourceIssue,
          sourceDescription: item.sourceDescription,
          signalAction: item.signal.action,
          cause: classification!.cause,
        },
      };

      generatedRequests.push(request);

      // 4. PostgreSQL service creates recovery issue
      const result = await service.ensureRecoveryIssue(request);
      expect(result.outcome).toBe("created");
      expect(result.recoveryActionId).toBeDefined();
      expect(result.recoveryIssueId).toBeDefined();

      createdActionIds.push(result.recoveryActionId);
      createdRecoveryIssueIds.push(result.recoveryIssueId!);
    }

    // Verify acceptance criteria for first pass:
    // Criterion 1: Exactly 9 distinct recovery actions created
    expect(createdActionIds).toHaveLength(9);
    expect(new Set(createdActionIds).size).toBe(9);

    // Criterion 2: Exactly 9 distinct recovery issues created
    expect(createdRecoveryIssueIds).toHaveLength(9);
    expect(new Set(createdRecoveryIssueIds).size).toBe(9);

    // Criterion 3: All 9 requests classify under valid ISSUE_RECOVERY_ACTION_KINDS
    expect(generatedRequests.every((r) => r.kind === "operator_action")).toBe(true);

    // Criterion 4: Exactly 7 distinct operator action causes across 9 actions
    const distinctCauses = new Set(
      generatedRequests.map((r) => (r.evidence as { cause: string }).cause),
    );
    expect(distinctCauses.size).toBe(7);

    // Criterion 5: Exactly 9 distinct dedupeKeys (9/9)
    const distinctDedupeKeys = new Set(generatedRequests.map((r) => r.dedupeKey));
    expect(distinctDedupeKeys.size).toBe(9);

    // Criterion 6: Database verification for created recovery actions and SLA calculations
    const persistedActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));

    expect(persistedActions).toHaveLength(9);

    for (const action of persistedActions) {
      expect(action.status).toBe("active");
      expect(action.ownerAgentId).not.toBeNull();
      expect(action.slaDueAt).not.toBeNull();

      // Verify SLA due time in DB matches the production SLA specification
      const expectedSlaMinutes = RECOVERY_SLA_MINUTES_BY_KIND[action.kind as IssueRecoveryActionKind];
      expect(expectedSlaMinutes).toBe(120);
      const expectedMinDue = startTime + expectedSlaMinutes * 60_000 - 5_000;
      expect(action.slaDueAt!.getTime()).toBeGreaterThanOrEqual(expectedMinDue);
    }

    // Criterion 7: Verify all recovery issues have assigned owners (no addressless issues)
    const persistedIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));

    // 1 source issue + 9 recovery issues = 10
    expect(persistedIssues).toHaveLength(10);

    const recoveryIssues = persistedIssues.filter((i) => i.id !== sourceIssueId);
    expect(recoveryIssues).toHaveLength(9);

    for (const issue of recoveryIssues) {
      expect(issue.originKind).toBe("recovery_factory");
      expect(issue.assigneeAgentId).not.toBeNull();
      expect(issue.status).toBe("todo");
      expect(createdRecoveryIssueIds).toContain(issue.id);
    }

    // Criterion 8: Blocker relations exist for each recovery issue
    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));

    expect(blockerRelations).toHaveLength(9);
    for (const rel of blockerRelations) {
      expect(rel.type).toBe("blocks");
      expect(rel.relatedIssueId).toBe(sourceIssueId);
      expect(createdRecoveryIssueIds).toContain(rel.issueId);
    }

    // --- PHASE 2: Second replay pass (same signals -> 0 new issues, 9 deduped) ---
    const replayResults = await Promise.all(
      generatedRequests.map((req) => service.ensureRecoveryIssue(req)),
    );

    expect(replayResults).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      expect(replayResults[i].outcome).toBe("deduped");
      expect(replayResults[i].recoveryActionId).toBe(createdActionIds[i]);
      expect(replayResults[i].recoveryIssueId).toBe(createdRecoveryIssueIds[i]);
    }

    // Verify no new issues or actions were created in the database
    const postReplayActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(postReplayActions).toHaveLength(9);

    const postReplayIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(postReplayIssues).toHaveLength(10);
  });

  it("verifies R5 classifier compatibility with operator signals", () => {
    for (const item of fixtures) {
      const r5Signal: RecoverySignal = {
        action: item.signal.action,
        issueId: item.signal.issueId,
      };
      const classified = classifyOperatorAction(r5Signal);
      expect(classified).not.toBeNull();
      expect(classified!.kind).toBe("operator_action");
      expect(classified!.scope).toBe("operator");
    }
  });
});
