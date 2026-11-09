// myrmidon(WAKE-STALL-ROOT-A): resurrection of wakes skipped with
// `execution_reconciliation_required` — see resurrection-service.ts and the
// inline re-enqueue point in modules/run-dispatch/adapters/postgres.ts.
//
// Contract under test: the resurrected wake is ORDINARY deferred queue input —
// status `deferred_issue_execution`, scoped by `payload ->> 'issueId'`, with no
// `executionWait` marker. That is the only shape the existing bounded serving
// paths understand: the release drain promotes it once the issue lock is free,
// and the stranded-wake reconcile cancels it on a terminal task or expires it
// after 30 minutes and re-wakes the agent. A bare `pending` row (the old
// producer contract) is read by no scheduler and strands forever — the exact
// production failure OPE-12347 records.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { ResurrectionService } from "./resurrection-service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("ResurrectionService (WAKE-STALL-ROOT A)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-resurrection-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Company A" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "agent-a",
        adapterType: "claude",
      })
      .returning();
    return { companyId: company.id, agentId: agent.id };
  }

  it("resurrects a skipped wake as scoped deferred_issue_execution queue input", async () => {
    const { companyId, agentId } = await seed();
    const issueId = crypto.randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      error: "execution_reconciliation_required",
      status: "skipped",
      payload: { issueId },
    });

    await ResurrectionService.handleResurrections(db, agentId);

    const newWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          eq(agentWakeupRequests.reason, "resurrection_execution_reconciliation_required"),
        ),
      );

    expect(newWakeups.length).toBe(1);
    expect(newWakeups[0].resurrectionCount).toBe(1);
    expect((newWakeups[0].payload as Record<string, unknown>).issueId).toBe(issueId);
    expect((newWakeups[0].payload as Record<string, unknown>).executionWait).toBeUndefined();
  });

  it("does not resurrect a wake without an issue scope: it could never be served", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      error: "execution_reconciliation_required",
      status: "skipped",
      payload: {},
    });

    await ResurrectionService.handleResurrections(db, agentId);

    const newWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "resurrection_execution_reconciliation_required"),
        ),
      );

    expect(newWakeups.length).toBe(0);
  });

  it("does not resurrect a wake whose recovery evidence blocks replay", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      error: "execution_reconciliation_required",
      status: "skipped",
      payload: {
        evidence: {
          automaticRecovery: {
            replay: "blocked",
          },
        },
      },
    });

    await ResurrectionService.handleResurrections(db, agentId);

    const newWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "resurrection_execution_reconciliation_required"),
        ),
      );

    expect(newWakeups.length).toBe(0);
  });

  it("does not resurrect a wake twice: the second skip stays terminal", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      error: "execution_reconciliation_required",
      status: "skipped",
      resurrectionCount: 1,
      payload: {},
    });

    await ResurrectionService.handleResurrections(db, agentId);

    const newWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "resurrection_execution_reconciliation_required"),
        ),
      );

    expect(newWakeups.length).toBe(0);
  });
});
