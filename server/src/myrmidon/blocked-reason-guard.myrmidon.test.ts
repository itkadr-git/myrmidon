import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issueRelations, issues } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { HttpError } from "../errors.js";
import { buildStrandedDispositionBlockedPatch } from "./stranded-autopolicy.js";
import { recoveryLivenessDescriptor } from "./stale-block/event-keys.js";
import {
  BLOCKED_REQUIRES_REASON_CODE,
  hasBlockedReason,
  isAutoUnblockCandidate,
} from "./blocked-reason-guard.js";

describe("hasBlockedReason", () => {
  it("rejects a task with no blocker, reason or descriptor", () => {
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: null, unblockDescriptor: null })).toBe(false);
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: {}, unblockDescriptor: { owner: "board", action: "  " } })).toBe(false);
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: null, unblockDescriptor: { action: "Do it" } })).toBe(false);
  });
  it("accepts a blocker, a blockReason or an owner+action descriptor", () => {
    expect(hasBlockedReason({ openBlockerCount: 1, blockerMetadata: null, unblockDescriptor: null })).toBe(true);
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: { blockReason: "dependency" }, unblockDescriptor: null })).toBe(true);
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: null, unblockDescriptor: { owner: "board", action: "Review" } })).toBe(true);
  });
  it("system descriptors satisfy the rule", () => {
    const stranded = buildStrandedDispositionBlockedPatch({ issueId: randomUUID(), ownerAgentId: randomUUID() });
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: stranded.blockerMetadata, unblockDescriptor: stranded.unblockDescriptor })).toBe(true);
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: null, unblockDescriptor: recoveryLivenessDescriptor(randomUUID(), "Inspect") })).toBe(true);
  });
  it("auto-unblock candidates need an executor and no stated reason", () => {
    const base = { status: "blocked", conversationAgentId: null, assigneeAgentId: randomUUID(), assigneeUserId: null, blockerMetadata: null, unblockDescriptor: null };
    expect(isAutoUnblockCandidate(base)).toBe(true);
    expect(isAutoUnblockCandidate({ ...base, assigneeAgentId: null })).toBe(false);
    expect(isAutoUnblockCandidate({ ...base, unblockDescriptor: { owner: "board", action: "Wait" } })).toBe(false);
    expect(isAutoUnblockCandidate({ ...base, blockerMetadata: { blockReason: "recovery" } })).toBe(false);
    expect(isAutoUnblockCandidate({ ...base, status: "todo" })).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("issueService blocked-reason guard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-blocked-reason-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS "issue_relations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "company_id" uuid NOT NULL,
        "issue_id" uuid NOT NULL,
        "related_issue_id" uuid NOT NULL,
        "type" text NOT NULL,
        "created_by_agent_id" uuid,
        "created_by_user_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Guard",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Dev", role: "engineer", status: "active",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const mk = async (n: number, status: string) => {
      const id = randomUUID();
      await db.insert(issues).values({
        id, companyId, identifier: `G-${n}`, title: `Issue ${n}`, status, priority: "medium",
        assigneeAgentId: agentId,
      });
      return id;
    };
    return { companyId, agentId, mk };
  }

  async function expectReasonRefusal(promise: Promise<unknown>) {
    const err = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).details).toMatchObject({ code: BLOCKED_REQUIRES_REASON_CODE });
  }

  it("refuses blocked without blocker, reason or descriptor (422)", async () => {
    const { mk } = await seed();
    const id = await mk(1, "todo");
    await expectReasonRefusal(svc.update(id, { status: "blocked" }));
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    expect(row!.status).toBe("todo");
  });

  it("refuses blocked when the only listed blocker is already done", async () => {
    const { mk } = await seed();
    const id = await mk(1, "todo");
    const doneBlocker = await mk(2, "done");
    await expectReasonRefusal(svc.update(id, { status: "blocked", blockedByIssueIds: [doneBlocker] }));
  });

  it("allows blocked with an open blocker", async () => {
    const { mk } = await seed();
    const id = await mk(1, "todo");
    const blocker = await mk(2, "in_progress");
    const updated = await svc.update(id, { status: "blocked", blockedByIssueIds: [blocker] });
    expect(updated?.status).toBe("blocked");
  });

  it("allows blocked with blockerMetadata.blockReason", async () => {
    const { mk, agentId } = await seed();
    const id = await mk(1, "todo");
    const updated = await svc.update(id, {
      status: "blocked",
      blockerMetadata: {
        blockReason: "recovery",
        owner: { agentId },
        nextCheckAt: new Date().toISOString(),
        timeoutAt: new Date().toISOString(),
        escalationPolicy: "notify_owner",
      } as never,
    });
    expect(updated?.status).toBe("blocked");
  });

  it("allows blocked with an unblockDescriptor owner+action; refuses one without action", async () => {
    const { mk } = await seed();
    const id = await mk(1, "todo");
    await expectReasonRefusal(
      svc.update(id, { status: "blocked", unblockDescriptor: { owner: "board", action: " " } as never }),
    );
    const updated = await svc.update(id, {
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve the spend" },
    });
    expect(updated?.status).toBe("blocked");
  });

  it("system paths keep working: stranded autopolicy patch and recovery liveness descriptor", async () => {
    const { mk, agentId } = await seed();
    const a = await mk(1, "in_progress");
    const b = await mk(2, "in_progress");
    const patch = buildStrandedDispositionBlockedPatch({ issueId: a, ownerAgentId: agentId });
    expect((await svc.update(a, patch))?.status).toBe("blocked");
    const viaDescriptor = await svc.update(b, {
      status: "blocked",
      unblockDescriptor: recoveryLivenessDescriptor(b, "Inspect the failed run"),
    });
    expect(viaDescriptor?.status).toBe("blocked");
  });

  it("re-asserting an already blocked legacy task is not refused", async () => {
    const { mk } = await seed();
    const id = await mk(1, "blocked");
    expect((await svc.update(id, { status: "blocked", title: "Renamed" }))?.status).toBe("blocked");
  });

  it("closing the last blocker returns a reasonless dependent to todo", async () => {
    const { mk } = await seed();
    const blocker = await mk(1, "in_progress");
    const dependent = await mk(2, "blocked");
    await svc.update(dependent, { blockedByIssueIds: [blocker] });
    await svc.update(blocker, { status: "done" });
    const [row] = await db.select().from(issues).where(eq(issues.id, dependent));
    expect(row!.status).toBe("todo");
    expect(row!.blockedTransitionAt).toBeNull();
  });

  it("does not return the dependent while another blocker is open", async () => {
    const { mk } = await seed();
    const first = await mk(1, "in_progress");
    const second = await mk(2, "in_progress");
    const dependent = await mk(3, "blocked");
    await svc.update(dependent, { blockedByIssueIds: [first, second] });
    await svc.update(first, { status: "done" });
    const [row] = await db.select().from(issues).where(eq(issues.id, dependent));
    expect(row!.status).toBe("blocked");
  });

  it("keeps a dependent that states another reason blocked", async () => {
    const { mk } = await seed();
    const blocker = await mk(1, "in_progress");
    const dependent = await mk(2, "todo");
    await svc.update(dependent, {
      status: "blocked",
      blockedByIssueIds: [blocker],
      unblockDescriptor: { owner: "board", action: "Also needs the owner decision" },
    });
    await svc.update(blocker, { status: "done" });
    const [row] = await db.select().from(issues).where(eq(issues.id, dependent));
    expect(row!.status).toBe("blocked");
  });

  it("a cancelled last blocker also returns the dependent to todo", async () => {
    const { mk } = await seed();
    const blocker = await mk(1, "in_progress");
    const dependent = await mk(2, "blocked");
    await svc.update(dependent, { blockedByIssueIds: [blocker] });
    await svc.update(blocker, { status: "cancelled" });
    const [row] = await db.select().from(issues).where(eq(issues.id, dependent));
    expect(row!.status).toBe("todo");
  });

  it("create in blocked needs a reason too", async () => {
    const { companyId, mk } = await seed();
    await expectReasonRefusal(svc.create(companyId, { title: "No reason", status: "blocked" } as never));
    const blocker = await mk(1, "in_progress");
    const withBlocker = await svc.create(companyId, { title: "With blocker", status: "blocked", blockedByIssueIds: [blocker] } as never);
    expect(withBlocker.status).toBe("blocked");
    const withDescriptor = await svc.create(companyId, {
      title: "With descriptor",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Decide" },
    } as never);
    expect(withDescriptor.status).toBe("blocked");
  });
});
