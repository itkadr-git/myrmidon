// myrmidon(REPLAY-BLOCK-TRIAGE): the attention feed shows one card per task
// locked by a settled "do not replay" hold, naming the responsible (assignee's
// manager, else the board operator) with a triage deadline, re-surfaces daily
// while the task stays locked, and disappears once the task is triaged
// (Restore / Done / Cancel / a cleared hold). The feed is computed live from
// the recovery rows — the same data the dispatcher and the replay-blocked list
// read — so there is no state to keep in sync here.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  inboxDismissals,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { attentionService } from "../../services/attention.js";
import { listReplayLockedCards, replayLockedResponsible } from "./attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HOLD_SETTLED_AT = new Date("2026-10-01T00:00:00.000Z");
const DAY_ONE = Date.parse("2026-10-09T12:00:00.000Z");
const DAY_TWO = Date.parse("2026-10-10T12:00:00.000Z");

describeEmbeddedPostgres("replay_locked attention card", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-replay-locked-attention-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(inboxDismissals);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLocked(opts: { issueStatus?: string } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "operator-a",
      requireBoardApprovalForNewAgents: false,
    });
    const [lead] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        companyId,
        name: "lead-a",
        role: "lead",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        companyId,
        name: "worker-a",
        role: "engineer",
        status: "idle",
        reportsTo: lead!.id,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "locked task",
        status: opts.issueStatus ?? "todo",
        priority: "high",
        assigneeAgentId: worker!.id,
      })
      .returning();
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId: issue!.id,
        kind: "active_run_watchdog",
        status: "resolved",
        cause: "execution_finalization_deadline_exceeded",
        fingerprint: randomUUID(),
        evidence: { automaticRecovery: { replay: "blocked" } },
        nextAction: "Reconcile the stopped run.",
      })
      .returning();
    // Pin the hold settlement date so the card's age/deadline are deterministic.
    await db
      .update(issueRecoveryActions)
      .set({ updatedAt: HOLD_SETTLED_AT })
      .where(eq(issueRecoveryActions.id, action!.id));
    return { companyId, leadId: lead!.id, workerId: worker!.id, issueId: issue!.id, actionId: action!.id };
  }

  function feed(now: number) {
    return async (companyId: string) =>
      attentionService(db, {
        feedCacheTtlMs: 0,
        now: () => now,
      }).list(companyId, { userId: "operator-a" });
  }

  async function lockedItem(companyId: string, now: number) {
    const snapshot = await feed(now)(companyId);
    return snapshot.items.find((item) => item.sourceKind === "replay_locked");
  }

  it("names the assignee's manager as the responsible on an overdue locked task", async () => {
    const { companyId, leadId, issueId } = await seedLocked();

    const card = (await listReplayLockedCards(db, companyId, DAY_ONE))[0]!;
    expect(card.issueId).toBe(issueId);
    expect(card.heldMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(replayLockedResponsible(card)).toMatchObject({ kind: "agent", id: leadId, label: "lead-a" });

    const item = await lockedItem(companyId, DAY_ONE);
    expect(item).toBeDefined();
    expect(item!.subject.id).toBe(issueId);
    expect(item!.severity).toBe("high");
    expect(item!.whyNow).toContain("lead-a");
    expect(item!.subject.metadata).toMatchObject({
      cause: "execution_finalization_deadline_exceeded",
      responsibleKind: "agent",
      responsibleId: leadId,
    });
    expect(item!.decisionVerbs.map((verb) => verb.id)).toContain("reassign");
  });

  it("falls back to the board operator when the assignee has no manager", async () => {
    const { companyId, workerId, issueId } = await seedLocked();
    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, workerId));

    const item = await lockedItem(companyId, DAY_ONE);
    expect(item).toBeDefined();
    expect(item!.subject.id).toBe(issueId);
    expect(item!.subject.metadata).toMatchObject({ responsibleKind: "user", responsibleLabel: "Board operator" });
    expect(item!.whyNow).toContain("Board operator");
  });

  it("re-surfaces the next day: a dismissal silences the card for its UTC day only", async () => {
    const { companyId } = await seedLocked();

    const dayOne = await lockedItem(companyId, DAY_ONE);
    expect(dayOne).toBeDefined();
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "operator-a",
      itemKey: dayOne!.dismissalKey,
      kind: "dismiss",
      dismissedAt: new Date(DAY_ONE),
    });
    // Same day: silenced.
    expect(await lockedItem(companyId, DAY_ONE)).toBeUndefined();
    // Next day: the dedup key rotated, the card is back while the lock stands.
    const dayTwo = await lockedItem(companyId, DAY_TWO);
    expect(dayTwo).toBeDefined();
    expect(dayTwo!.dedupKey).not.toBe(dayOne!.dedupKey);
    expect(dayTwo!.dedupKey).toContain("2026-10-10");
  });

  it("disappears once triaged: Restore (active action), Done, Cancel, or a cleared hold", async () => {
    const { companyId, actionId } = await seedLocked();
    expect(await lockedItem(companyId, DAY_ONE)).toBeDefined();

    // Restore: the recovery action is active again and carries the vendor
    // recovery card instead.
    await db
      .update(issueRecoveryActions)
      .set({ status: "active", evidence: {} })
      .where(eq(issueRecoveryActions.id, actionId));
    expect(await lockedItem(companyId, DAY_ONE)).toBeUndefined();
    await db
      .update(issueRecoveryActions)
      .set({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } })
      .where(eq(issueRecoveryActions.id, actionId));

    // Done closes the task — no card.
    const [issue] = await db.select().from(issues);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue!.id));
    expect(await lockedItem(companyId, DAY_ONE)).toBeUndefined();

    // Cancelled — no card.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issue!.id));
    expect(await lockedItem(companyId, DAY_ONE)).toBeUndefined();

    // Reopened with the hold cleared (the operator's "Review and clear") — no card.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issue!.id));
    expect(await lockedItem(companyId, DAY_ONE)).toBeDefined();
    await db
      .update(issueRecoveryActions)
      .set({
        evidence: { automaticRecovery: { replay: "cleared", replayClearedNote: "triaged" } },
      })
      .where(eq(issueRecoveryActions.id, actionId));
    expect(await lockedItem(companyId, DAY_ONE)).toBeUndefined();
  });

  it("includes a locked task that lost its executor — the board operator owns the unblock", async () => {
    const { companyId } = await seedLocked();
    const workerRow = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, "worker-a"));
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.companyId, companyId));

    const item = await lockedItem(companyId, DAY_ONE);
    expect(item).toBeDefined();
    expect(item!.subject.metadata).toMatchObject({
      responsibleKind: "user",
      responsibleId: "operator-a",
    });
    void workerRow;
  });
});
