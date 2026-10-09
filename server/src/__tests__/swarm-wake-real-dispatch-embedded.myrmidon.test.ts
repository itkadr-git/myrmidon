// server/src/__tests__/swarm-wake-real-dispatch-embedded.myrmidon.test.ts
//
// myrmidon(1.6.5 OPE-6608, final review items 1 and 3).
//
//   1  the supervisor rebalance route builds its matcher with the caste directory:
//      a task released by the supervisor is not handed to an agent whose caste has
//      `swarmEligible: false`;
//   3  the matcher's wake goes through the REAL path, not a stub: the matcher
//      assigns the task to a free agent, `queueIssueAssignmentWakeup` calls the
//      real `heartbeatService(db).wakeup`, and the wake is accepted — a wake
//      request and a run for this very issue exist, and neither is closed as
//      `skipped` / cancelled for `issue_reassigned` (the 09.10 audit: 3259 empty
//      runs of exactly that kind). Only the adapter's `execute` is a mock, so no
//      provider process is started.
//
// Neutral data only: company, agent-a, agent-b.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentCastes,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueClaims,
  issueComments,
  issues,
} from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { SWARM_MATCHED_WAKE_REASON, resolveSwarmClaimSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { createCasteDirectoryReader } from "../myrmidon/castes/directory.js";
import { buildSwarmMatcher } from "../myrmidon/swarm-claim/matcher-factory.js";
import { swarmSupervisorRoutes } from "../myrmidon/swarm-claim-supervisor/routes.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Swarm real dispatch test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const baseSettings = resolveSwarmClaimSettings({ env: {} }).settings;

describeEmbeddedPostgres("swarm wake: real dispatch and the supervisor caste gate", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-real-dispatch-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issueClaims);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(agentCastes);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Swarm Co",
      issuePrefix: `SW${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    // Reading the directory seeds the default castes of the company.
    await createCasteDirectoryReader(db)(companyId);
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedTask(companyId: string, assigneeAgentId: string | null = null) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${companyId.slice(0, 4).toUpperCase()}-1`,
      title: "ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  async function assigneeOf(issueId: string) {
    const [row] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
    return row?.assigneeAgentId ?? null;
  }

  function settingsPort() {
    return {
      getGeneral: async () => ({ swarm: { ...baseSettings, enabled: true } }),
      updateGeneral: async () => {
        throw new Error("not used");
      },
    };
  }

  // -------------------------------------------------------------------------
  // Item 1: the supervisor rebalance honours the caste directory.
  // -------------------------------------------------------------------------
  describe("supervisor rebalance", () => {
    async function seedHeldTask() {
      const companyId = await seedCompany();
      const holderId = await seedAgent(companyId, "agent-a");
      const freeId = await seedAgent(companyId, "agent-b");
      const issueId = await seedTask(companyId, holderId);
      const claimId = randomUUID();
      const now = new Date();
      await db.insert(issueClaims).values({
        id: claimId,
        companyId,
        issueId,
        agentId: holderId,
        role: "engineer",
        runId: null,
        claimedAt: new Date(now.getTime() - 60_000),
        heartbeatAt: new Date(now.getTime() - 60_000),
        expiresAt: new Date(now.getTime() + 600_000),
      });
      return { companyId, holderId, freeId, issueId, claimId };
    }

    function rebalanceApp(companyId: string, wakes: string[]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = {
          type: "board",
          source: "local_implicit",
          userId: "board-user",
          isInstanceAdmin: true,
          companyIds: [companyId],
        };
        next();
      });
      app.use(
        "/api",
        swarmSupervisorRoutes(db, {
          db,
          // The switch comes from the environment: the route builds its own settings service.
          env: { MYRMIDON_SWARM_CLAIM_ENABLED: "true" },
          now: () => new Date(),
          enqueueWakeup: async (agentId) => {
            wakes.push(agentId);
            return { id: randomUUID() } as never;
          },
        }),
      );
      return app;
    }

    async function release(companyId: string, claimId: string, wakes: string[]) {
      return request(rebalanceApp(companyId, wakes))
        .post(`/api/myrmidon/companies/${companyId}/swarm-claim/supervisor/release-lease`)
        .send({ claimId });
    }

    it("control: with the caste eligible the released task goes to a free agent", async () => {
      const wakes: string[] = [];
      const { companyId, claimId, issueId } = await seedHeldTask();

      const res = await release(companyId, claimId, wakes);

      expect(res.status).toBe(200);
      expect(res.body.released).toBe(true);
      expect(res.body.wokenAgentId).toBeTruthy();
      expect(wakes).toHaveLength(1);
      expect(await assigneeOf(issueId)).toBe(res.body.wokenAgentId);
    });

    it("does not hand the released task to an agent whose caste has swarmEligible=false", async () => {
      const wakes: string[] = [];
      const { companyId, claimId, issueId } = await seedHeldTask();
      await db
        .update(agentCastes)
        .set({ swarmEligible: false })
        .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.key, "engineer")));

      const res = await release(companyId, claimId, wakes);

      expect(res.status).toBe(200);
      expect(res.body.released).toBe(true);
      expect(res.body.wokenAgentId).toBeNull();
      expect(wakes).toEqual([]);
      expect(await assigneeOf(issueId)).toBeNull();
      const live = await db
        .select({ id: issueClaims.id })
        .from(issueClaims)
        .where(and(eq(issueClaims.issueId, issueId), isNull(issueClaims.releasedAt)));
      expect(live).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Item 3: the matcher's wake through the real heartbeat admission.
  // -------------------------------------------------------------------------
  describe("matcher wake through the real heartbeat path", () => {
    it("assigns the task, and the real wake is accepted: a run for this issue, none closed as reassigned", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "agent-a");
      const issueId = await seedTask(companyId);

      const matcher = await buildSwarmMatcher({
        db,
        env: {},
        settings: settingsPort(),
        // The real wake: matcher -> queueIssueAssignmentWakeup -> heartbeat.wakeup.
        enqueueWakeup: (id, opts) => heartbeat.wakeup(id, opts as never),
        castes: createCasteDirectoryReader(db),
        hostGateOpen: () => true,
      } as never);
      expect(matcher).not.toBeNull();

      const pair = await matcher!.forIssue(issueId);

      expect(pair?.agentId).toBe(agentId);
      expect(await assigneeOf(issueId)).toBe(agentId);
      // The lease is still held: the wake was accepted, nothing was rolled back.
      const live = await db
        .select({ agentId: issueClaims.agentId })
        .from(issueClaims)
        .where(and(eq(issueClaims.issueId, issueId), isNull(issueClaims.releasedAt)));
      expect(live).toEqual([{ agentId }]);

      const wakeRows = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).filter(
        (row) => (row.payload as { issueId?: string } | null)?.issueId === issueId,
      );
      expect(wakeRows.length).toBeGreaterThan(0);
      expect(wakeRows.every((row) => row.status !== "skipped")).toBe(true);
      expect(wakeRows.some((row) => row.reason === SWARM_MATCHED_WAKE_REASON)).toBe(true);

      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).filter(
        (run) => (run.contextSnapshot as { issueId?: string } | null)?.issueId === issueId,
      );
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.errorCode).not.toBe("issue_reassigned");
        expect(run.status).not.toBe("cancelled");
      }
      expect(mockAdapterExecute).toHaveBeenCalled();
      // And after the run the board did not hand the task back to nobody.
      expect(await assigneeOf(issueId)).toBe(agentId);
    });
  });
});
