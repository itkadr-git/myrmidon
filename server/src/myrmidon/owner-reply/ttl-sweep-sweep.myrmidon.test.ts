// myrmidon(1.6.5-F21-B): the owner-card TTL sweep against embedded Postgres —
// an overdue owner card is closed in one pass (expired, or resolved by the
// recommended option in silence-means-recommended mode), the task gets the
// "expired without an answer" comment, the author is woken exactly once, and
// a repeated pass never duplicates the wake. The delivery metadata the sweep
// derives is folded into the card payload.

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "@paperclipai/db";
import { useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
import {
  createOwnerCardTtlSweep,
  OWNER_CARD_EXPIRED_WAKE_IDEMPOTENCY_PREFIX,
  OWNER_CARD_EXPIRED_WAKE_REASON,
  type OwnerCardTtlSweepDeps,
} from "./ttl-sweep.js";

const COMPANY = "cccccccc-0000-4000-8000-000000000001";
const AUTHOR_AGENT = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_USER = "dddddddd-0000-4000-8000-000000000001";
const OTHER_USER = "dddddddd-0000-4000-8000-000000000002";
const ISSUE = "eeeeeeee-0000-4000-8000-000000000001";

const NOW = new Date("2026-01-05T00:00:00.000Z");
const TTL_MS = 72 * 60 * 60 * 1000;
const OLD = new Date(NOW.getTime() - TTL_MS - 3_600_000); // 73 h old — past the TTL
const FRESH = new Date(NOW.getTime() - 60_000); // 1 min old — inside the TTL

describeEmbeddedPostgres("owner card TTL sweep (embedded PG)", () => {
  const { db } = useEmbeddedPostgres("owner-card-ttl");

  beforeEach(async () => {
    await db.insert(companies).values({ id: COMPANY, name: "Acme" });
    await db.insert(agents).values({ id: AUTHOR_AGENT, companyId: COMPANY, name: "agent-a" });
    await db.insert(issues).values({
      id: ISSUE,
      companyId: COMPANY,
      title: "Owner card issue",
      status: "in_progress",
      responsibleUserId: OWNER_USER,
    });
  });

  function makeSweep(wakeups: unknown[][] = []) {
    const wakeup = vi.fn(async (agentId: string, options: Record<string, unknown>) => {
      wakeups.push([agentId, options]);
      const values = [{
        agentId,
        reason: String(options.reason),
        idempotencyKey: (options.idempotencyKey as string | null) ?? null,
        source: "automation",
        triggerDetail: "system",
        payload: options.payload ?? null,
      }] as const;
      await db.insert(agentWakeupRequests).values(values as any);
      return null;
    });
    const deps: OwnerCardTtlSweepDeps = { db, wakeup };
    return {
      wakeup,
      sweep: createOwnerCardTtlSweep(deps),
      run: () =>
        createOwnerCardTtlSweep(deps)({
          now: NOW,
          settings: { ttlMs: TTL_MS, intervalMs: 0, pageSize: 50, wakeBudget: 20 },
        }),
    };
  }

  async function insertCard(overrides: Record<string, unknown> = {}) {
    const values = {
      companyId: COMPANY,
      issueId: ISSUE,
      kind: "request_confirmation",
      status: "pending",
      effectiveResolverPolicy: "any",
      addresseeUserId: OWNER_USER,
      createdByAgentId: AUTHOR_AGENT,
      payload: { version: 1, target: { type: "none" } },
      createdAt: OLD,
      updatedAt: OLD,
      ...overrides,
    };
    const [row] = await db.insert(issueThreadInteractions).values(values as any).returning({ id: issueThreadInteractions.id });
    return row.id;
  }

  async function readCard(id: string) {
    return db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, id))
      .then((rows) => rows[0]!);
  }

  async function pendingOverdueCount() {
    const rows = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
        ),
      );
    return rows.length;
  }

  async function commentsWithReason(reason: string) {
    const rows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, ISSUE))
      .orderBy(desc(issueComments.createdAt));
    return rows.filter(
      (row) =>
        row.metadata &&
        typeof row.metadata === "object" &&
        (row.metadata as unknown as Record<string, unknown>).authorizationReason === reason,
    );
  }

  it("expires every pending owner card older than the TTL, comments, and wakes the author once", async () => {
    const cardA = await insertCard();
    const cardB = await insertCard();
    await insertCard({ addresseeAgentId: AUTHOR_AGENT, addresseeUserId: null }); // agent card — not an owner card
    await insertCard({ createdAt: FRESH, updatedAt: FRESH }); // fresh — inside the TTL

    const { run, wakeup } = makeSweep();
    const first = await run();
    expect(first.inspected).toBe(2);
    expect(first.expired).toBe(2);
    expect(first.silenceResolved).toBe(0);
    expect(first.failed).toBe(0);
    expect(first.woken).toBe(2);

    // The acceptance criterion: no pending overdue owner card survives the pass.
    expect(await pendingOverdueCount()).toBe(1); // only the fresh one remains

    for (const id of [cardA, cardB]) {
      const card = await readCard(id);
      expect(card.status).toBe("expired");
      expect(card.result).toMatchObject({ outcome: "expired", reason: "interaction_expired" });
      const payload = card.payload as unknown as Record<string, unknown>;
      expect(payload.delivery).toMatchObject({
        sentTo: OWNER_USER,
        sentAt: OLD.toISOString(),
        answeredAt: null,
      });
    }

    const comments = await commentsWithReason("myrmidon_owner_card_ttl");
    expect(comments).toHaveLength(2);
    expect(comments[0]!.body).toContain("истекла без ответа");
    expect(comments[0]!.authorType).toBe("system");

    expect(wakeup).toHaveBeenCalledTimes(2);
    const [, options] = (wakeup.mock.calls[0] as unknown[]) as [string, Record<string, unknown>];
    expect(options.reason).toBe(OWNER_CARD_EXPIRED_WAKE_REASON);
    expect(String(options.idempotencyKey)).toMatch(
      new RegExp(`^${OWNER_CARD_EXPIRED_WAKE_IDEMPOTENCY_PREFIX}`),
    );

    // A second pass closes nothing new and wakes nobody again (the limiter).
    const second = await run();
    expect(second.inspected).toBe(0);
    expect(second.expired).toBe(0);
    expect(second.woken).toBe(0);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("resolves a silence-means-recommended card by the recommended option instead of expiring it", async () => {
    const card = await insertCard({
      payload: {
        version: 1,
        target: { type: "none" },
        silenceMeansRecommended: true,
        recommendedOption: "accept",
      },
    });

    const { run, wakeup } = makeSweep();
    const result = await run();
    expect(result.silenceResolved).toBe(1);
    expect(result.expired).toBe(0);

    const resolved = await readCard(card);
    expect(resolved.status).toBe("accepted");

    const comments = await commentsWithReason("myrmidon_owner_card_ttl");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("молчание");

    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("expires a silence-means-recommended card of the money class anyway", async () => {
    const card = await insertCard({
      payload: {
        version: 1,
        target: { type: "none" },
        silenceMeansRecommended: true,
        decisionClass: "money",
        recommendedOption: "accept",
      },
    });

    const { run } = makeSweep();
    const result = await run();
    expect(result.silenceResolved).toBe(0);
    expect(result.expired).toBe(1);

    const closed = await readCard(card);
    expect(closed.status).toBe("expired");
  });

  it("records the sweep close in the activity log", async () => {
    await insertCard();
    const { run } = makeSweep();
    await run();
    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, ISSUE));
    expect(rows.some((row) => row.action === "issue.thread_interaction_expired")).toBe(true);
  });

  it("leaves a card answered concurrently with the sweep untouched", async () => {
    const card = await insertCard();
    // A human answer landed between the selection and the close: the sweep's
    // compare-and-set on status=pending loses the race and leaves the card.
    await db
      .update(issueThreadInteractions)
      .set({ status: "accepted", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, card));

    const { run, wakeup } = makeSweep();
    const result = await run();
    expect(result.inspected).toBe(0); // no longer pending, never selected
    expect(wakeup).not.toHaveBeenCalled();
    expect((await readCard(card)).status).toBe("accepted");
  });
});
