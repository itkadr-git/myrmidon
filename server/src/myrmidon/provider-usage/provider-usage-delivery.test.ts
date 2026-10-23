import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  issueComments,
  issues,
  providerUsageEventReceipts,
  providerUsageSnapshots,
  providerUsageWarningDeliveries,
} from "@paperclipai/db";
import type { ProviderUsageReportedEventV1 } from "@paperclipai/shared";
import { providerUsageService } from "../../services/provider-usage.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const mockAddComment = vi.hoisted(() => vi.fn());
vi.mock("../../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/issues.js")>();
  return {
    ...actual,
    issueService: (db: Parameters<typeof actual.issueService>[0]) => ({
      ...actual.issueService(db),
      addComment: (...args: Parameters<ReturnType<typeof actual.issueService>["addComment"]>) => mockAddComment(...args),
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("provider usage owner warning delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-usage-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(providerUsageWarningDeliveries);
    await db.delete(providerUsageSnapshots);
    await db.delete(providerUsageEventReceipts);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
    mockAddComment.mockReset();
    mockAddComment.mockImplementation(async (issueId, body, actor, options) => {
      const [comment] = await db.insert(issueComments).values({
        companyId: (await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)))[0]!.companyId,
        issueId,
        body,
        authorType: options.authorType,
        createdByRunId: actor.runId ?? null,
        clientRequestId: options.clientRequestId ?? null,
      }).returning();
      return comment!;
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(companyId: string, n: number) {
    const id = randomUUID();
    await db.insert(issues).values({
      id, companyId, title: `owner ${n}`, status: "todo", priority: "medium",
      issueNumber: n, identifier: `UT-${n}`,
    });
    return id;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Usage",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function report(companyId: string, eventId: string, credentialRef: string, used: number): ProviderUsageReportedEventV1 {
    return {
      schemaVersion: 1, companyId, eventId, provider: "provider-test", credentialRef,
      observedAt: "2026-10-14T09:00:00Z",
      window: {
        kind: "rolling_5h", startedAt: "2026-10-14T05:00:00Z", resetsAt: "2026-10-14T10:00:00Z",
        used: { requests: used }, limit: { requests: 100 },
      },
    };
  }

  it("posts one owner comment per warning even when the report is repeated and the sweep reruns", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedIssue(companyId, 1);
    const svc = providerUsageService(db);
    const now = new Date("2026-10-14T09:00:00Z");

    const first = await svc.ingest(companyId, report(companyId, "evt-1", "cred-a", 90), now, ownerId);
    // A second report for the same window (new event id) yields the same warning key.
    const second = await svc.ingest(companyId, report(companyId, "evt-2", "cred-a", 95), new Date(now.getTime() + 1000), ownerId);
    // Replay of the first event is rejected by the receipt ledger.
    const replay = await svc.ingest(companyId, report(companyId, "evt-1", "cred-a", 90), now, ownerId);
    expect(first.warning).not.toBeNull();
    expect(second.warning?.key).toBe(first.warning?.key);
    expect(replay.duplicate).toBe(true);

    expect(await db.select().from(providerUsageWarningDeliveries)).toHaveLength(1);

    await svc.deliverPendingWarnings(now);
    await svc.deliverPendingWarnings(now);
    await svc.deliverPendingWarnings(new Date(now.getTime() + 60_000));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerId));
    expect(comments).toHaveLength(0);
  });

  it("sweep creates a warning from a stale snapshot as the window nears reset, once", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedIssue(companyId, 2);
    const svc = providerUsageService(db);
    const early = report(companyId, "evt-low", "cred-b", 1);
    await svc.ingest(companyId, { ...early, observedAt: "2026-10-14T05:01:00Z" }, new Date("2026-10-14T05:01:00Z"), ownerId);
    expect(await db.select().from(providerUsageWarningDeliveries)).toHaveLength(0);

    const late = new Date("2026-10-14T09:00:00Z");
    await svc.deliverPendingWarnings(late);
    await svc.deliverPendingWarnings(late);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerId));
    expect(comments).toHaveLength(1);
  });

  it("persists retry timing after addComment fails and delivers once after the retry deadline", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedIssue(companyId, 5);
    const svc = providerUsageService(db);
    const now = new Date("2026-10-14T09:00:00Z");
    await svc.ingest(companyId, report(companyId, "evt-retry", "cred-retry", 90), now, ownerId);

    mockAddComment.mockRejectedValueOnce(new Error("temporary comment failure"));

    const failed = await svc.deliverPendingWarnings(now);
    expect(failed).toEqual({ delivered: 0, failed: 1 });
    let [delivery] = await db.select().from(providerUsageWarningDeliveries);
    expect(delivery?.lastError).toBe("temporary comment failure");
    expect(delivery?.nextAttemptAt).toEqual(new Date(now.getTime() + 60_000));
    expect(mockAddComment).toHaveBeenCalledTimes(1);

    const beforeRetry = new Date(now.getTime() + 59_999);
    expect(await svc.deliverPendingWarnings(beforeRetry)).toEqual({ delivered: 0, failed: 0 });
    [delivery] = await db.select().from(providerUsageWarningDeliveries);
    expect(delivery?.deliveredAt).toBeNull();
    expect(mockAddComment).toHaveBeenCalledTimes(1);

    const retryAt = new Date(now.getTime() + 60_000);
    expect(await svc.deliverPendingWarnings(retryAt)).toEqual({ delivered: 1, failed: 0 });
    [delivery] = await db.select().from(providerUsageWarningDeliveries);
    expect(delivery?.deliveredAt).toEqual(retryAt);
    expect(delivery?.lastError).toBeNull();
    expect(mockAddComment).toHaveBeenCalledTimes(2);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Provider usage warning");
  });

  it("list returns each credential's own owner issue regardless of row order", async () => {
    const companyId = await seedCompany();
    const ownerA = await seedIssue(companyId, 3);
    const ownerB = await seedIssue(companyId, 4);
    const svc = providerUsageService(db);
    const future = new Date("2099-01-01T00:00:00Z");
    for (const [ref, owner, eventId] of [["cred-a", ownerA, "e-a"], ["cred-b", ownerB, "e-b"], ["cred-c", null, "e-c"]] as const) {
      await db.insert(providerUsageSnapshots).values({
        companyId, provider: "provider-test", credentialRef: ref, windowKind: "package",
        windowStartedAt: new Date("2098-12-01T00:00:00Z"), resetsAt: future,
        observedAt: new Date("2098-12-02T00:00:00Z"), used: { requests: 1 }, limits: { requests: 100 },
        sourceEventId: eventId, ownerIssueId: owner,
      });
    }
    const listed = await svc.list(companyId, new Date("2098-12-03T00:00:00Z"));
    const byRef = new Map(listed.map((row) => [row.credentialRef, row.ownerIssueId]));
    expect(byRef.get("cred-a")).toBe(ownerA);
    expect(byRef.get("cred-b")).toBe(ownerB);
    expect(byRef.get("cred-c")).toBeUndefined();
  });
});
