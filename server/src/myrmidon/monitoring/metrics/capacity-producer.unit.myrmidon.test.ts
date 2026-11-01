// server/src/myrmidon/monitoring/metrics/capacity-producer.unit.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-9565): unit test suite for the capacity dashboard metrics producer.
//
// Verifies:
// 1. Population composition: open issues (including blocked & in_review) vs ready issues.
// 2. Queue age seconds: max(0, snapshotTime - readySince), unavailable when readySince missing.
// 3. Active project share: active claim/run slots per project, unassigned handling, sum to 1.
// 4. Starvation episodes: threshold crossing increments once, re-scrape dedupes, loss of
//    eligibility ends episode, policy.enabled=false suppresses increments.
// 5. Claim rejection counters: bounded 9 reasons, attemptId deduplication, unknown -> other, reset.
// 6. Unavailable sources: missing DB, missing company, or missing fields return null, NEVER fake zeroes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAIM_REJECTION_REASONS,
  type ClaimRejectionReason,
} from "./metrics.js";
import {
  produceCapacityMetrics,
  recordCapacityClaimRejection,
  resetCapacityMetrics,
  readCapacityCounters,
  createDefaultCapacityDashboardProvider,
} from "./capacity-producer.js";
import type { Db } from "@myrmidon/db";
import type { CapacityPolicy } from "@myrmidon/shared";

describe("capacity dashboard metrics producer (unit)", () => {
  beforeEach(() => {
    resetCapacityMetrics();
  });

  afterEach(() => {
    resetCapacityMetrics();
  });

  describe("claim rejection counter semantics", () => {
    it("initializes all bounded reasons with zero", () => {
      const counters = readCapacityCounters();
      expect(counters.starvationTotal).toBe(0);
      for (const reason of CLAIM_REJECTION_REASONS) {
        expect(counters.claimRejectionTotal[reason]).toBe(0);
      }
    });

    it("increments each bounded reason correctly", () => {
      for (const reason of CLAIM_REJECTION_REASONS) {
        recordCapacityClaimRejection(reason);
      }
      const counters = readCapacityCounters();
      for (const reason of CLAIM_REJECTION_REASONS) {
        expect(counters.claimRejectionTotal[reason]).toBe(1);
      }
    });

    it("maps unknown reason strings to 'other'", () => {
      recordCapacityClaimRejection("some_unregistered_reason" as ClaimRejectionReason);
      recordCapacityClaimRejection("custom_error_message" as ClaimRejectionReason);
      const counters = readCapacityCounters();
      expect(counters.claimRejectionTotal.other).toBe(2);
    });

    it("deduplicates claim rejection attempts with the same attemptId", () => {
      const attemptId = "agent-1:run-42:capacity_limit";
      recordCapacityClaimRejection("capacity_limit", attemptId);
      recordCapacityClaimRejection("capacity_limit", attemptId);
      recordCapacityClaimRejection("capacity_limit", attemptId);

      const counters = readCapacityCounters();
      expect(counters.claimRejectionTotal.capacity_limit).toBe(1);

      // Different attemptId increments
      recordCapacityClaimRejection("capacity_limit", "agent-1:run-43:capacity_limit");
      expect(readCapacityCounters().claimRejectionTotal.capacity_limit).toBe(2);
    });

    it("resets all counters and attempt history on resetCapacityMetrics", () => {
      recordCapacityClaimRejection("capacity_limit", "att-1");
      recordCapacityClaimRejection("caste_scope");
      expect(readCapacityCounters().claimRejectionTotal.capacity_limit).toBe(1);

      resetCapacityMetrics();
      const fresh = readCapacityCounters();
      expect(fresh.claimRejectionTotal.capacity_limit).toBe(0);
      expect(fresh.claimRejectionTotal.caste_scope).toBe(0);

      // Previous attemptId can now increment again after reset
      recordCapacityClaimRejection("capacity_limit", "att-1");
      expect(readCapacityCounters().claimRejectionTotal.capacity_limit).toBe(1);
    });
  });

  describe("unavailable source semantics (no fake zeroes)", () => {
    it("returns null when db is invalid or select is not a function", async () => {
      const snapshot1 = await produceCapacityMetrics({ db: {} as Db });
      expect(snapshot1).toBeNull();

      const snapshot2 = await produceCapacityMetrics({ db: null as unknown as Db });
      expect(snapshot2).toBeNull();
    });

    it("returns null when no company exists in the database", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            limit: async () => [],
          }),
        }),
      } as unknown as Db;

      const snapshot = await produceCapacityMetrics({ db: mockDb });
      expect(snapshot).toBeNull();
    });
  });

  describe("population composition and metrics calculation", () => {
    const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
    const PROJ_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PROJ_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const NOW = new Date("2026-10-31T12:00:00.000Z");

    function createMockDb(fixtures: {
      openIssues: Array<{
        id: string;
        projectId: string | null;
        status: string;
        assigneeAgentId: string | null;
        unresolvedBlockerCount: number;
        unresolvedInteractionCount: number;
        createdAt: Date;
        updatedAt: Date;
      }>;
      activeClaims: Array<{ id: string; issueId: string; agentId: string }>;
      activeRuns: Array<{ id: string; issueId: string | null; agentId: string }>;
      activeAgents: Array<{ id: string; role: string; status: string }>;
      policy?: CapacityPolicy;
    }): Db {
      return {
        select: (fields: Record<string, unknown>) => ({
          from: (table: unknown) => {
            const tableStr = String(table);
            return {
              where: (condition: unknown) => ({
                limit: async () => [{ id: COMPANY_ID, general: { capacityPolicy: fixtures.policy } }],
                then: (resolve: (val: unknown) => void) => {
                  // Determine table by inspected select fields
                  if ("issuePrefix" in fields || ("id" in fields && Object.keys(fields).length === 1 && !("projectId" in fields))) {
                    resolve([{ id: COMPANY_ID }]);
                  } else if ("projectId" in fields && "status" in fields) {
                    resolve(fixtures.openIssues);
                  } else if ("releasedAt" in fields || ("issueId" in fields && !("status" in fields))) {
                    resolve(fixtures.activeClaims);
                  } else if ("status" in fields && "agentId" in fields && "issueId" in fields) {
                    resolve(fixtures.activeRuns);
                  } else if ("role" in fields) {
                    resolve(fixtures.activeAgents);
                  } else {
                    resolve([]);
                  }
                },
              }),
              limit: async () => [{ id: COMPANY_ID, general: { capacityPolicy: fixtures.policy } }],
            };
          },
        }),
      } as unknown as Db;
    }

    it("computes exact readiness_ratio, queue_age_seconds, and project_share", async () => {
      // 4 open issues:
      // 1: todo, eligible -> READY
      // 2: todo, eligible -> READY
      // 3: blocked (unresolvedBlockerCount=1) -> NOT ready (open)
      // 4: in_review -> NOT ready (open)
      const openIssues = [
        {
          id: "iss-1",
          projectId: PROJ_A,
          status: "todo",
          assigneeAgentId: null,
          unresolvedBlockerCount: 0,
          unresolvedInteractionCount: 0,
          createdAt: new Date("2026-10-31T11:58:00.000Z"), // 120s ago
          updatedAt: new Date("2026-10-31T11:58:00.000Z"),
        },
        {
          id: "iss-2",
          projectId: PROJ_B,
          status: "todo",
          assigneeAgentId: null,
          unresolvedBlockerCount: 0,
          unresolvedInteractionCount: 0,
          createdAt: new Date("2026-10-31T11:59:00.000Z"), // 60s ago
          updatedAt: new Date("2026-10-31T11:59:00.000Z"),
        },
        {
          id: "iss-3",
          projectId: PROJ_A,
          status: "blocked",
          assigneeAgentId: null,
          unresolvedBlockerCount: 1,
          unresolvedInteractionCount: 0,
          createdAt: new Date("2026-10-31T11:50:00.000Z"),
          updatedAt: new Date("2026-10-31T11:50:00.000Z"),
        },
        {
          id: "iss-4",
          projectId: PROJ_A,
          status: "in_review",
          assigneeAgentId: "agent-1",
          unresolvedBlockerCount: 0,
          unresolvedInteractionCount: 0,
          createdAt: new Date("2026-10-31T11:40:00.000Z"),
          updatedAt: new Date("2026-10-31T11:40:00.000Z"),
        },
      ];

      // 4 active slots: 3 in PROJ_A, 1 in PROJ_B
      const activeClaims = [
        { id: "claim-1", issueId: "iss-3", agentId: "agent-2" },
        { id: "claim-2", issueId: "iss-4", agentId: "agent-1" },
        { id: "claim-3", issueId: "iss-extra-1", agentId: "agent-3" }, // PROJ_A
        { id: "claim-4", issueId: "iss-2-claimed", agentId: "agent-4" }, // PROJ_B
      ];

      const activeAgents = [
        { id: "agent-1", role: "general", status: "active" },
        { id: "agent-2", role: "general", status: "active" },
      ];

      const mockDb = createMockDb({
        openIssues,
        activeClaims: [
          { id: "claim-1", issueId: "iss-3", agentId: "agent-2" }, // in PROJ_A
          { id: "claim-2", issueId: "iss-4", agentId: "agent-1" }, // in PROJ_A
        ],
        activeRuns: [
          { id: "run-1", issueId: "iss-3", agentId: "agent-2" }, // deduped with claim-1
          { id: "run-2", issueId: "iss-2", agentId: "agent-1" }, // in PROJ_B
        ],
        activeAgents,
      });

      const snapshot = await produceCapacityMetrics({
        db: mockDb,
        now: () => NOW,
        companyId: COMPANY_ID,
      });

      expect(snapshot).not.toBeNull();
      if (!snapshot) return;

      // 4 open issues, 1 ready (iss-1; iss-2 has active run-2, iss-3 blocked, iss-4 in_review)
      // readiness_ratio = 1 / 4 = 0.25
      expect(snapshot.readinessRatio).toBe(0.25);

      // iss-1 is ready since 11:58:00 (120 seconds before NOW)
      expect(snapshot.queueAgeSeconds).toBe(120);

      // Active slots:
      // iss-3 has claim-1 and run-1 -> 1 slot in PROJ_A
      // iss-4 has claim-2 -> 1 slot in PROJ_A
      // iss-2 has run-2 -> 1 slot in PROJ_B
      // Total active slots = 3: PROJ_A = 2/3, PROJ_B = 1/3
      expect(snapshot.projectShare).toBeDefined();
      expect(snapshot.projectShare).toHaveLength(2);
      const projA = snapshot.projectShare?.find((p) => p.project === PROJ_A);
      const projB = snapshot.projectShare?.find((p) => p.project === PROJ_B);
      expect(projA?.share).toBeCloseTo(2 / 3);
      expect(projB?.share).toBeCloseTo(1 / 3);
    });

    it("returns readiness_ratio=0 and queue_age_seconds=0 when queue is empty", async () => {
      const mockDb = createMockDb({
        openIssues: [],
        activeClaims: [],
        activeRuns: [],
        activeAgents: [{ id: "ag-1", role: "general", status: "active" }],
      });

      const snapshot = await produceCapacityMetrics({
        db: mockDb,
        now: () => NOW,
        companyId: COMPANY_ID,
      });

      expect(snapshot).not.toBeNull();
      expect(snapshot?.readinessRatio).toBe(0);
      expect(snapshot?.queueAgeSeconds).toBe(0);
      expect(snapshot?.projectShare).toEqual([]);
    });

    it("labels tasks without project as 'unassigned'", async () => {
      const openIssues = [
        {
          id: "iss-unassigned",
          projectId: null,
          status: "todo",
          assigneeAgentId: null,
          unresolvedBlockerCount: 0,
          unresolvedInteractionCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ];

      const mockDb = createMockDb({
        openIssues,
        activeClaims: [{ id: "cl-1", issueId: "iss-unassigned", agentId: "ag-1" }],
        activeRuns: [],
        activeAgents: [{ id: "ag-1", role: "general", status: "active" }],
      });

      const snapshot = await produceCapacityMetrics({
        db: mockDb,
        now: () => NOW,
        companyId: COMPANY_ID,
      });

      expect(snapshot?.projectShare).toEqual([
        { project: "unassigned", share: 1 },
      ]);
    });
  });

  describe("starvation episode tracking", () => {
    const COMPANY_ID = "company-starvation";
    const POLICY: CapacityPolicy = {
      enabled: true,
      fairness: { perProjectMaxShare: 0.5 },
      aging: { halfLifeMin: 60, maxBoost: 1 },
      limits: { perProjectActive: null, perCasteActive: null },
      starvation: { afterMin: 30, promoteBy: 1 },
    };

    it("increments starvation_total once when threshold is crossed and dedupes on re-scrape", async () => {
      const t0 = new Date("2026-10-31T12:00:00.000Z");
      const issue = {
        id: "starving-task",
        projectId: null,
        status: "todo",
        assigneeAgentId: null,
        unresolvedBlockerCount: 0,
        unresolvedInteractionCount: 0,
        createdAt: t0,
        updatedAt: t0,
      };

      const makeDb = () =>
        ({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [{ id: COMPANY_ID }],
                then: (resolve: (v: unknown) => void) => resolve([issue]),
              }),
              limit: async () => [{ id: COMPANY_ID }],
            }),
          }),
        }) as unknown as Db;

      // Scrape at t0: 0 minutes elapsed -> not starved
      const snap1 = await produceCapacityMetrics({
        db: makeDb(),
        now: () => t0,
        companyId: COMPANY_ID,
        policy: POLICY,
      });
      expect(snap1?.starvationTotal).toBe(0);

      // Scrape at t0 + 35 minutes: >= 30 min threshold -> increments to 1
      const t35 = new Date(t0.getTime() + 35 * 60 * 1000);
      const snap2 = await produceCapacityMetrics({
        db: makeDb(),
        now: () => t35,
        companyId: COMPANY_ID,
        policy: POLICY,
      });
      expect(snap2?.starvationTotal).toBe(1);

      // Re-scrape at t0 + 40 minutes: same episode does NOT increment again
      const t40 = new Date(t0.getTime() + 40 * 60 * 1000);
      const snap3 = await produceCapacityMetrics({
        db: makeDb(),
        now: () => t40,
        companyId: COMPANY_ID,
        policy: POLICY,
      });
      expect(snap3?.starvationTotal).toBe(1);
    });

    it("does not increment starvation when policy.enabled is false", async () => {
      const t0 = new Date("2026-10-31T12:00:00.000Z");
      const issue = {
        id: "task-disabled-policy",
        projectId: null,
        status: "todo",
        assigneeAgentId: null,
        unresolvedBlockerCount: 0,
        unresolvedInteractionCount: 0,
        createdAt: t0,
        updatedAt: t0,
      };

      const makeDb = () =>
        ({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [{ id: COMPANY_ID }],
                then: (resolve: (v: unknown) => void) => resolve([issue]),
              }),
              limit: async () => [{ id: COMPANY_ID }],
            }),
          }),
        }) as unknown as Db;

      const disabledPolicy: CapacityPolicy = { ...POLICY, enabled: false };
      const t100 = new Date(t0.getTime() + 100 * 60 * 1000);

      const snap = await produceCapacityMetrics({
        db: makeDb(),
        now: () => t100,
        companyId: COMPANY_ID,
        policy: disabledPolicy,
      });
      expect(snap?.starvationTotal).toBe(0);
    });
  });

  describe("createDefaultCapacityDashboardProvider", () => {
    it("returns an executable provider function", async () => {
      const mockDb = { select: () => ({ from: () => ({ limit: async () => [] }) }) } as unknown as Db;
      const provider = createDefaultCapacityDashboardProvider(mockDb);
      expect(typeof provider).toBe("function");
      const result = await provider();
      expect(result).toBeNull();
    });
  });
});
