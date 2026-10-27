import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issueRelations, issues } from "@myrmidon/db";
import { buildRecoveryDedupeKey, type RecoveryFactoryRequest } from "@myrmidon/shared";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { classifyGithubRecoveryCause } from "../services/recovery-factory/classify-github.js";
import { classifyWorkspaceRecoveryCause } from "../services/recovery-factory/classify-workspace.js";
import { classifyDiskRecoveryCause } from "../services/recovery-factory/classify-disk-operator.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { representativeRecoveryFixtures, type RepresentativeRecoveryFixture } from "./__fixtures__/recovery-factory-representative.js";

const support = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !support.supported) {
  throw new Error(`Representative recovery replay requires PostgreSQL: ${support.reason}`);
}
const describePg = support.supported ? describe : describe.skip;

function classify(fixture: RepresentativeRecoveryFixture) {
  switch (fixture.group) {
    case "github": return classifyGithubRecoveryCause(fixture.signal);
    case "workspace": return classifyWorkspaceRecoveryCause(fixture.signal);
    case "disk": return classifyDiskRecoveryCause(fixture.signal);
  }
}

describePg("representative recovery factory PostgreSQL replay", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("recovery-representative-");
    db = createDb(pg.connectionString);
  }, 120_000);

  afterAll(async () => { await pg?.cleanup(); });

  async function setup() {
    const companyId = randomUUID();
    const ownerId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Representative replay", issuePrefix: `RR${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: ownerId, companyId, name: "Recovery owner", role: "engineer" });
    await db.insert(issues).values({ id: sourceIssueId, companyId, title: "Replay source", issueNumber: 1 });
    return { companyId, ownerId, sourceIssueId };
  }

  function requestFor(
    fixture: RepresentativeRecoveryFixture,
    context: Awaited<ReturnType<typeof setup>>,
    resourceScope: string,
  ): RecoveryFactoryRequest {
    const classification = classify(fixture);
    expect(classification, fixture.source).not.toBeNull();
    if (!classification) throw new Error(`Unrecognized source: ${fixture.source}`);
    expect(classification).toMatchObject({ kind: fixture.expectedKind, cause: fixture.expectedCause });
    // R4/R5 expose category scopes rather than resource identities. The caller
    // must add its concrete workspace/host scope before invoking R7. These are
    // synthetic replay identities; the signal text above remains unchanged.
    const scope = `${classification.scope}:${resourceScope}`;
    return {
      kind: classification.kind,
      sourceIssueId: context.sourceIssueId,
      dedupeKey: buildRecoveryDedupeKey({ kind: classification.kind, cause: classification.cause, scope }),
      owner: { agentId: context.ownerId },
      slaMinutes: 30,
      nextCheckAt: "2026-12-01T10:00:00Z",
      runbookRef: "OPE-8312#5.7",
      evidence: { source: fixture.source, signal: fixture.signal, cause: classification.cause, scope },
    };
  }

  it("keeps at least twelve distinct sourced causes with three to five per group", () => {
    expect(representativeRecoveryFixtures.length).toBeGreaterThanOrEqual(12);
    expect(new Set(representativeRecoveryFixtures.map(f => f.expectedCause)).size).toBe(representativeRecoveryFixtures.length);
    for (const group of ["github", "workspace", "disk"] as const) {
      const count = representativeRecoveryFixtures.filter(f => f.group === group).length;
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBeLessThanOrEqual(5);
    }
  });

  it.each(representativeRecoveryFixtures)("$group/$id creates exactly one owned recovery with SLA and dedupes duplicate events", async fixture => {
    const context = await setup();
    const request = requestFor(fixture, context, "resource-a");
    const before = Date.now();
    const results = await Promise.all([
      issueRecoveryActionService(db).ensureRecoveryIssue(request),
      issueRecoveryActionService(db).ensureRecoveryIssue(request),
    ]);
    const after = Date.now();
    expect(results.map(r => r.outcome).sort()).toEqual(["created", "deduped"]);
    expect(new Set(results.map(r => r.recoveryIssueId)).size).toBe(1);
    expect(new Set(results.map(r => r.recoveryActionId)).size).toBe(1);
    const replay = await issueRecoveryActionService(db).ensureRecoveryIssue(request);
    expect(replay).toMatchObject({ outcome: "deduped", recoveryIssueId: results[0].recoveryIssueId, recoveryActionId: results[0].recoveryActionId });

    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, context.companyId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: request.kind, sourceIssueId: context.sourceIssueId,
      recoveryIssueId: results[0].recoveryIssueId, ownerAgentId: context.ownerId,
      dedupeKey: request.dedupeKey, evidence: request.evidence,
      nextCheckAt: new Date(request.nextCheckAt), runbookRef: request.runbookRef,
      wakePolicy: { owner: request.owner, nextCheckAt: request.nextCheckAt },
    });
    expect(actions[0].slaDueAt).toBeInstanceOf(Date);
    expect(actions[0].slaDueAt!.getTime()).toBeGreaterThanOrEqual(before + request.slaMinutes * 60_000);
    expect(actions[0].slaDueAt!.getTime()).toBeLessThanOrEqual(after + request.slaMinutes * 60_000);
    const rows = await db.select().from(issues).where(eq(issues.companyId, context.companyId));
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.id === results[0].recoveryIssueId)).toMatchObject({ assigneeAgentId: context.ownerId, status: "todo" });
    const blockers = await db.select().from(issueRelations).where(eq(issueRelations.companyId, context.companyId));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ type: "blocks", issueId: results[0].recoveryIssueId, relatedIssueId: context.sourceIssueId });
  });

  it.each(representativeRecoveryFixtures)("$group/$id does not collapse the same cause on different resource scopes", async fixture => {
    const context = await setup();
    const first = requestFor(fixture, context, "resource-a");
    const second = requestFor(fixture, context, "resource-b");
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    const service = issueRecoveryActionService(db);
    const results = await Promise.all([service.ensureRecoveryIssue(first), service.ensureRecoveryIssue(second)]);
    expect(results.map(r => r.outcome)).toEqual(["created", "created"]);
    expect(new Set(results.map(r => r.recoveryIssueId)).size).toBe(2);
    expect(new Set(results.map(r => r.recoveryActionId)).size).toBe(2);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, context.companyId))).toHaveLength(2);
    expect(await db.select().from(issues).where(eq(issues.companyId, context.companyId))).toHaveLength(3);
    expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, context.companyId))).toHaveLength(2);
    for (const [index, request] of [first, second].entries()) {
      expect(await service.ensureRecoveryIssue(request)).toMatchObject({ outcome: "deduped", recoveryIssueId: results[index].recoveryIssueId });
    }
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, context.companyId))).toHaveLength(2);
  });
});
