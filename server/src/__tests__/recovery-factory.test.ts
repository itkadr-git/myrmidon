import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issueRelations, issues } from "@myrmidon/db";
import type { RecoveryFactoryRequest } from "@myrmidon/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

const support = await getEmbeddedPostgresTestSupport();
// CI must execute the acceptance tests, never silently skip PostgreSQL coverage.
if (process.env.CI && !support.supported) throw new Error(`Recovery factory requires PostgreSQL: ${support.reason}`);
const describePg = support.supported ? describe : describe.skip;

describePg("ensureRecoveryIssue PostgreSQL", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("recovery-factory-");
    db = createDb(pg.connectionString);
  }, 120_000);
  afterAll(async () => { await pg?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const ownerId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `RF${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: ownerId, companyId, name: "Owner", role: "engineer" });
    await db.insert(issues).values({ id: sourceIssueId, companyId, title: "Source", issueNumber: 7 });
    const request: RecoveryFactoryRequest = {
      kind: "missing_disposition", sourceIssueId, dedupeKey: randomUUID(),
      owner: { agentId: ownerId }, slaMinutes: 30,
      nextCheckAt: "2026-12-01T10:00:00Z", runbookRef: "runbook/recovery", evidence: { event: "failed" },
    };
    const metrics = { created: vi.fn(), deduped: vi.fn(), succeeded: vi.fn(), age: vi.fn() };
    return { companyId, ownerId, request, metrics };
  }

  it.each(Array.from({ length: 10 }, (_, i) => i))("creates exactly one issue/action and blocker across independent concurrent callers (round %i)", async () => {
    const { companyId, ownerId, request, metrics } = await fixture();
    const before = Date.now();
    const results = await Promise.all([
      issueRecoveryActionService(db, metrics).ensureRecoveryIssue(request),
      issueRecoveryActionService(db, metrics).ensureRecoveryIssue(request),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["created", "deduped"]);
    expect(results[0].recoveryActionId).toBe(results[1].recoveryActionId);
    expect(results[0].recoveryIssueId).toBe(results[1].recoveryIssueId);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      ownerAgentId: ownerId, dedupeKey: request.dedupeKey, evidence: request.evidence,
      nextCheckAt: new Date(request.nextCheckAt), runbookRef: request.runbookRef,
      wakePolicy: { owner: request.owner, nextCheckAt: request.nextCheckAt },
    });
    expect(actions[0].slaDueAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === results[0].recoveryIssueId)).toMatchObject({ assigneeAgentId: ownerId, status: "todo", issueNumber: 8 });
    const edges = await db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ type: "blocks", issueId: results[0].recoveryIssueId, relatedIssueId: request.sourceIssueId });
    expect(metrics.created).toHaveBeenCalledExactlyOnceWith(request.kind);
    expect(metrics.deduped).toHaveBeenCalledExactlyOnceWith(request.kind);
  });

  it("deduplicates a fingerprint-only legacy action without allocating another issue", async () => {
    const { companyId, request, metrics } = await fixture();
    const original = await issueRecoveryActionService(db).ensureRecoveryIssue(request);
    // Legacy writers do not populate dedupe_key. Only the fingerprint index
    // conflicts here, so a dedupe-key-only arbiter cannot pass this regression.
    await db.update(issueRecoveryActions).set({ dedupeKey: null })
      .where(eq(issueRecoveryActions.id, original.recoveryActionId));
    const results = await Promise.all([
      issueRecoveryActionService(db, metrics).ensureRecoveryIssue(request),
      issueRecoveryActionService(db, metrics).ensureRecoveryIssue(request),
    ]);
    expect(results).toEqual([0, 1].map(() => ({ ...original, outcome: "deduped" })));
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(2);
    expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId))).toHaveLength(1);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.issueCounter).toBe(8);
    expect(metrics.created).not.toHaveBeenCalled();
    expect(metrics.deduped).toHaveBeenCalledTimes(2);
    expect(metrics.deduped).toHaveBeenNthCalledWith(1, request.kind);
    expect(metrics.deduped).toHaveBeenNthCalledWith(2, request.kind);
  });

  it.each(["owner", "slaMinutes"] as const)("rejects missing %s without writes or metrics", async (field) => {
    const { companyId, request, metrics } = await fixture();
    const invalid: Record<string, unknown> = { ...request };
    delete invalid[field];
    await expect(issueRecoveryActionService(db, metrics).ensureRecoveryIssue(invalid as RecoveryFactoryRequest)).rejects.toThrow();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    expect(metrics.created).not.toHaveBeenCalled();
    expect(metrics.deduped).not.toHaveBeenCalled();
  });

  it.each([{ userId: "operator" }, { serviceQueue: "recovery" }])("persists owner %j", async (owner) => {
    const { request } = await fixture();
    const result = await issueRecoveryActionService(db).ensureRecoveryIssue({ ...request, owner });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, result.recoveryActionId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, result.recoveryIssueId!));
    if ("userId" in owner) {
      expect(action.ownerUserId).toBe(owner.userId);
      expect(issue.assigneeUserId).toBe(owner.userId);
    } else {
      expect(action.ownerQueue).toBe(owner.serviceQueue);
      expect(action.wakePolicy).toMatchObject({ owner });
    }
  });

  it("rolls back the issue, action and counter if the blocker write fails", async () => {
    const { companyId, request, metrics } = await fixture();
    await db.execute(sql`CREATE FUNCTION reject_factory_edge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test blocker failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_factory_edge BEFORE INSERT ON issue_relations FOR EACH ROW EXECUTE FUNCTION reject_factory_edge()`);
    try {
      await expect(issueRecoveryActionService(db, metrics).ensureRecoveryIssue(request)).rejects.toThrow();
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
      expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(company.issueCounter).toBe(0);
      expect(metrics.created).not.toHaveBeenCalled();
      expect(metrics.deduped).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`DROP TRIGGER reject_factory_edge ON issue_relations`);
      await db.execute(sql`DROP FUNCTION reject_factory_edge()`);
    }
    expect((await issueRecoveryActionService(db, metrics).ensureRecoveryIssue(request)).outcome).toBe("created");
  });

  it("scopes dedupe by company and supports distinct keys on one source", async () => {
    const first = await fixture();
    const second = await fixture();
    const service = issueRecoveryActionService(db);
    const results = await Promise.all([
      service.ensureRecoveryIssue(first.request),
      service.ensureRecoveryIssue({ ...second.request, dedupeKey: first.request.dedupeKey }),
    ]);
    expect(results.every((r) => r.outcome === "created")).toBe(true);
    expect(results[0].recoveryIssueId).not.toBe(results[1].recoveryIssueId);
    expect((await service.ensureRecoveryIssue({ ...first.request, dedupeKey: randomUUID() })).outcome).toBe("created");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, first.companyId))).toHaveLength(2);
  });

  it("rejects an agent from another company", async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(issueRecoveryActionService(db, first.metrics).ensureRecoveryIssue({
      ...first.request, owner: { agentId: second.ownerId },
    })).rejects.toThrow("source company");
    expect(first.metrics.created).not.toHaveBeenCalled();
  });
});
