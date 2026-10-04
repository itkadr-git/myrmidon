// myrmidon(HOLD-READY): the schedulers' "ready" agrees with the wake
// admission's execution hold — see ready-predicate.ts.
//
// The state under test is the one that stalled a whole team: a task in
// `todo`, a closed recovery action whose `evidence.automaticRecovery.replay`
// reads "blocked", and a wake the admission parked on it
// (`deferred_issue_execution` with `payload.executionWait`). Before the fix
// idle-pickup, the manual-wake binding and the swarm sweep counted the parked
// wake as "covering" the task, and nothing ever woke it again — not even after
// the hold was gone.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child(this: unknown) {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { findTopReadyIssueForAgent, idlePickupForAgent } from "../idle-pickup.js";
import { listRoleQueue, listUnassignedQueue } from "../swarm-claim/queue.js";
import { listIdleRolePairs } from "../swarm-claim/idle-queue.js";
import { issueHasLiveClaimOrWake } from "../swarm-claim/sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("HOLD-READY: ready means not held, and a parked wake is not cover", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-hold-ready-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { assigned?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "high",
      assigneeAgentId: input.assigned === false ? null : agentId,
    });
    return { companyId, agentId, issueId };
  }

  /** A closed recovery action; `replay` "blocked" is the settled hold, "cleared" a lifted one. */
  async function seedSettledAction(companyId: string, issueId: string, replay: "blocked" | "cleared") {
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        status: "resolved",
        cause: "uncertain_provider_action",
        fingerprint: randomUUID(),
        evidence: { automaticRecovery: { replay } },
        nextAction: "Preserve recorded work without replay.",
      })
      .returning();
    return action!.id;
  }

  /** The wake the admission parks on an execution hold (heartbeat.ts deferBlockedExecution). */
  async function seedParkedWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    recoveryActionId: string | null;
  }) {
    const [wake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_reopened_via_comment",
        status: "deferred_issue_execution",
        requestedByActorType: "user",
        requestedByActorId: "user-a",
        payload: {
          issueId: input.issueId,
          ...(input.recoveryActionId
            ? {
                executionWait: {
                  recoveryActionId: input.recoveryActionId,
                  reason: "process_identity_missing",
                  message: "The previous run has no verified stop record.",
                },
              }
            : {}),
        },
      })
      .returning();
    return wake!.id;
  }

  function enqueueSpy() {
    return vi.fn(async (_agentId: string, _opts: Record<string, unknown>) => ({ id: randomUUID() }));
  }

  function pickup(enqueueWakeup: ReturnType<typeof enqueueSpy>, agent: { id: string; companyId: string }) {
    return idlePickupForAgent(
      {
        db,
        enqueueWakeup: enqueueWakeup as unknown as Parameters<typeof idlePickupForAgent>[0]["enqueueWakeup"],
      },
      agent,
    );
  }

  describe("idle-pickup and the manual-wake binding", () => {
    it("a held task is not reported as ready, so no wake is sent only to be parked", async () => {
      const { companyId, agentId, issueId } = await seed();
      await seedSettledAction(companyId, issueId, "blocked");
      const enqueueWakeup = enqueueSpy();

      const result = await pickup(enqueueWakeup, { id: agentId, companyId });

      // Before the fix the held task passed the prefilter and was woken; the
      // admission then parked that wake.
      expect(result.considered).toBe(0);
      expect(result.woken).toBe(0);
      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(await findTopReadyIssueForAgent(db, { id: agentId, companyId })).toBeNull();
    });

    it("an active reconciliation action holds the task too", async () => {
      const { companyId, agentId, issueId } = await seed();
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "execution_reconciliation",
        status: "active",
        cause: "uncertain_provider_action",
        fingerprint: randomUUID(),
        evidence: {},
        nextAction: "Confirm what the provider did.",
      });

      expect(await findTopReadyIssueForAgent(db, { id: agentId, companyId })).toBeNull();
    });

    it("the stuck production state: held task with a parked wake — skipped while the hold stands", async () => {
      const { companyId, agentId, issueId } = await seed();
      const actionId = await seedSettledAction(companyId, issueId, "blocked");
      await seedParkedWake({ companyId, agentId, issueId, recoveryActionId: actionId });
      const enqueueWakeup = enqueueSpy();

      const result = await pickup(enqueueWakeup, { id: agentId, companyId });

      expect(result.woken).toBe(0);
      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(await findTopReadyIssueForAgent(db, { id: agentId, companyId })).toBeNull();
    });

    it("once the hold is lifted, the wake parked on it no longer covers the task: idle-pickup wakes it", async () => {
      const { companyId, agentId, issueId } = await seed();
      const actionId = await seedSettledAction(companyId, issueId, "cleared");
      await seedParkedWake({ companyId, agentId, issueId, recoveryActionId: actionId });
      const enqueueWakeup = enqueueSpy();

      const result = await pickup(enqueueWakeup, { id: agentId, companyId });

      // Before the fix: alreadyActive 1, woken 0 — the parked wake was "cover".
      expect(result.woken).toBe(1);
      expect(result.issueIds).toEqual([issueId]);
      expect(enqueueWakeup).toHaveBeenCalledTimes(1);
      expect(enqueueWakeup.mock.calls[0]![1]).toMatchObject({ contextSnapshot: { issueId } });
      expect((await findTopReadyIssueForAgent(db, { id: agentId, companyId }))?.id).toBe(issueId);
    });

    it("an ordinary deferred wake (not parked on a hold) still covers the task", async () => {
      const { companyId, agentId, issueId } = await seed();
      await seedParkedWake({ companyId, agentId, issueId, recoveryActionId: null });
      const enqueueWakeup = enqueueSpy();

      const result = await pickup(enqueueWakeup, { id: agentId, companyId });

      expect(result.woken).toBe(0);
      expect(result.alreadyActive).toBe(1);
      expect(await findTopReadyIssueForAgent(db, { id: agentId, companyId })).toBeNull();
    });
  });

  describe("swarm queues and the swarm sweep", () => {
    it("a held task is in no role queue, the unassigned queue or the idle pass", async () => {
      const assigned = await seed();
      await seedSettledAction(assigned.companyId, assigned.issueId, "blocked");
      const unassigned = await seed({ assigned: false });
      await seedSettledAction(unassigned.companyId, unassigned.issueId, "blocked");

      expect(await listRoleQueue(db, assigned.companyId, "engineer")).toEqual([]);
      expect(await listUnassignedQueue(db, unassigned.companyId)).toEqual([]);
      expect(await listIdleRolePairs(db, assigned.companyId)).toEqual([]);
      expect(await listIdleRolePairs(db, unassigned.companyId)).toEqual([]);
    });

    it("a task whose hold was lifted is back in the queue", async () => {
      const { companyId, issueId } = await seed();
      await seedSettledAction(companyId, issueId, "cleared");

      expect((await listRoleQueue(db, companyId, "engineer")).map((row) => row.issueId)).toEqual([issueId]);
      const pairs = await listIdleRolePairs(db, companyId);
      expect(pairs.flatMap((pair) => pair.queue.map((row) => row.issueId))).toEqual([issueId]);
    });

    it("a wake parked on an execution hold does not cover the task; an ordinary deferred wake does", async () => {
      const parked = await seed();
      const actionId = await seedSettledAction(parked.companyId, parked.issueId, "cleared");
      await seedParkedWake({ ...parked, recoveryActionId: actionId });
      // Before the fix: true — the sweep skipped the task for good.
      expect(await issueHasLiveClaimOrWake(db, parked.companyId, parked)).toBe(false);

      const ordinary = await seed();
      await seedParkedWake({ ...ordinary, recoveryActionId: null });
      expect(await issueHasLiveClaimOrWake(db, ordinary.companyId, ordinary)).toBe(true);
    });
  });
});
