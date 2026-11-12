import { describe, expect, it, vi } from "vitest";
import {
  type Db,
  agents,
  connectionEventDeliveries,
  heartbeatRunEvents,
  instanceSettings,
  issueComments,
  issues,
  issueWorkProducts,
} from "@myrmidon/db";
import { collectDevflowHealth } from "./collector.js";

const now = new Date("2026-10-27T20:00:00.000Z");
const companyId = "company-devflow-test";

function createMockDb(fixtures: {
  instanceSettings?: Array<{ general?: Record<string, unknown> }>;
  agents?: Array<any>;
  reviews?: Array<{ id: string; title: string; since: Date }>;
  products?: Array<{
    product: any;
    issue: any;
  }>;
  comments?: Array<{
    issueId: string;
    body: string;
    createdAt: Date;
    authorAgentId?: string | null;
    authorUserId?: string | null;
    authorType?: string | null;
  }>;
  deliveries?: Array<{
    payload: any;
    at?: Date;
    receivedAt: Date;
  }>;
  latestMerged?: Array<{ mergedAt: Date | null }>;
  garbageEvents?: Array<{
    id: number;
    agentId: string;
    createdAt: Date;
    payload: Record<string, unknown> | null;
  }>;
}): any {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        let hasJoin = false;
        const queryChain: any = {
          innerJoin: vi.fn(() => {
            hasJoin = true;
            return queryChain;
          }),
          leftJoin: vi.fn(() => queryChain),
          where: vi.fn(() => queryChain),
          limit: vi.fn(() => queryChain),
          then: (resolve: (val: any) => void) => {
            if (table === agents) {
              return resolve(fixtures.agents ?? []);
            }
            if (table === issues) {
              return resolve(fixtures.reviews ?? []);
            }
            if (table === issueWorkProducts) {
              if (hasJoin) {
                return resolve(fixtures.products ?? []);
              }
              return resolve(fixtures.latestMerged ?? [{ mergedAt: null }]);
            }
            if (table === issueComments) {
              return resolve(fixtures.comments ?? []);
            }
            if (table === connectionEventDeliveries) {
              return resolve(fixtures.deliveries ?? []);
            }
            if (table === instanceSettings) {
              return resolve(fixtures.instanceSettings ?? []);
            }
            if (table === heartbeatRunEvents) {
              return resolve(fixtures.garbageEvents ?? []);
            }
            return resolve(fixtures.instanceSettings ?? []);
          },
        };
        return queryChain;
      }),
    })),
  };
}

describe("collectDevflowHealth", () => {
  it("evaluates approvedNotMergedMs even when metadata.repo and metadata.number are absent", async () => {
    const issueId = "issue-no-repo";
    const db = createMockDb({
      products: [
        {
          product: {
            id: "prod-1",
            status: "open",
            type: "pull_request",
            provider: "github",
            externalId: "101",
            createdAt: new Date("2026-10-27T16:00:00Z"),
            metadata: { headSha: "eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3" }, // No repo, no number!
          },
          issue: {
            id: issueId,
            title: "Task with PR missing repo metadata",
            status: "in_review",
            assigneeAgentId: "rev-1",
            createdByAgentId: "author-1",
          },
        },
      ],
      comments: [
        {
          issueId,
          body: "APPROVE PR #101 eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3\n\nCode review approved.",
          createdAt: new Date("2026-10-27T17:00:00Z"), // 3 hours ago -> > 2h threshold
          authorAgentId: "rev-1",
        },
      ],
      latestMerged: [{ mergedAt: new Date("2026-10-27T19:00:00Z") }], // 1h ago -> no queue stall
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    const approvedSignal = signals.find((s) => s.metric === "approvedNotMergedMs");
    expect(approvedSignal).toBeDefined();
    expect(approvedSignal).toMatchObject({
      companyId,
      subjectId: issueId,
      subjectKind: "issue",
      metric: "approvedNotMergedMs",
      durationMs: 3 * 3600_000,
      dedupKey: `devflow:${companyId}:approvedNotMergedMs:${issueId}`,
    });
  });

  it("skips merged and closed pull requests from approvedNotMergedMs", async () => {
    const db = createMockDb({
      products: [
        {
          product: {
            id: "prod-merged",
            status: "merged",
            type: "pull_request",
            provider: "github",
            externalId: "102",
            metadata: { number: 102, headSha: "eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3" },
          },
          issue: { id: "issue-merged", title: "Merged task", status: "done" },
        },
        {
          product: {
            id: "prod-closed",
            status: "closed",
            type: "pull_request",
            provider: "github",
            externalId: "103",
            metadata: { number: 103, headSha: "eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3" },
          },
          issue: { id: "issue-closed", title: "Closed task", status: "done" },
        },
      ],
      comments: [
        {
          issueId: "issue-merged",
          body: "APPROVE PR #102 eb7e5cec37ed6bd3b307e180c3d107c6586c8cc3",
          createdAt: new Date("2026-10-27T15:00:00Z"),
        },
      ],
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    expect(signals.filter((s) => s.metric === "approvedNotMergedMs")).toEqual([]);
  });

  it("emits noMergesMs alert when active queue is non-empty and 0 merges in >6 hours", async () => {
    const issueId = "issue-waiting";
    const db = createMockDb({
      products: [
        {
          product: {
            id: "prod-active",
            status: "open",
            type: "pull_request",
            provider: "github",
            externalId: "201",
            createdAt: new Date("2026-10-27T12:00:00Z"),
            metadata: { repo: "itkadr-git/myrmidon", number: 201 },
          },
          issue: {
            id: issueId,
            title: "Task waiting for merge",
            status: "in_progress",
          },
        },
      ],
      // Last merge occurred 8 hours ago (> 6 hour threshold)
      latestMerged: [{ mergedAt: new Date("2026-10-27T12:00:00.000Z") }],
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    const noMergesSignal = signals.find((s) => s.metric === "noMergesMs");
    expect(noMergesSignal).toBeDefined();
    expect(noMergesSignal).toMatchObject({
      companyId,
      subjectId: issueId,
      subjectKind: "issue",
      metric: "noMergesMs",
      durationMs: 8 * 3600_000,
      dedupKey: `devflow:${companyId}:noMergesMs:${issueId}`,
    });
  });

  it("does not emit noMergesMs when PR was merged recently (<6 hours)", async () => {
    const db = createMockDb({
      products: [
        {
          product: {
            id: "prod-active",
            status: "open",
            type: "pull_request",
            provider: "github",
            externalId: "202",
            createdAt: new Date("2026-10-27T18:00:00Z"),
            metadata: { number: 202 },
          },
          issue: { id: "issue-202", title: "Task 202", status: "in_progress" },
        },
      ],
      // Last merge occurred 2 hours ago (< 6h)
      latestMerged: [{ mergedAt: new Date("2026-10-27T18:00:00.000Z") }],
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    expect(signals.find((s) => s.metric === "noMergesMs")).toBeUndefined();
  });

  it("does not emit noMergesMs when active PR queue is empty", async () => {
    const db = createMockDb({
      products: [],
      latestMerged: [{ mergedAt: new Date("2026-10-27T10:00:00.000Z") }],
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    expect(signals.find((s) => s.metric === "noMergesMs")).toBeUndefined();
  });

  it("emits a critical providerGarbageP1 signal from a persisted burst event", async () => {
    const db = createMockDb({
      garbageEvents: [{
        id: 1,
        agentId: "agent-garbage",
        createdAt: new Date("2026-10-27T19:59:00.000Z"),
        payload: {
          outcomeText: "server overloaded",
          modelGroup: "nexus-grok-4.7",
          runCount: 5,
        },
      }],
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    expect(signals.find((s) => s.metric === "providerGarbageP1")).toMatchObject({
      subjectId: "agent-garbage",
      severity: "critical",
      detail: {
        outcomeText: "server overloaded",
        modelGroup: "nexus-grok-4.7",
        runCount: 5,
      },
    });
  });

  it("does not emit providerGarbageP1 for an event outside the ten-minute window", async () => {
    const db = createMockDb({
      garbageEvents: [{
        id: 2,
        agentId: "agent-old",
        createdAt: new Date("2026-10-27T19:49:59.000Z"),
        payload: { outcomeText: "server overloaded", modelGroup: "nexus-grok-4.7" },
      }],
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    expect(signals.find((s) => s.metric === "providerGarbageP1")).toBeUndefined();
  });

  it("does not emit providerGarbageP1 when the event has no outcome text", async () => {
    const db = createMockDb({
      garbageEvents: [{
        id: 3,
        agentId: "agent-empty",
        createdAt: new Date("2026-10-27T19:59:00.000Z"),
        payload: { modelGroup: "nexus-grok-4.7" },
      }],
    });

    const signals = await collectDevflowHealth(db, companyId, now);
    expect(signals.find((s) => s.metric === "providerGarbageP1")).toBeUndefined();
  });
});

// Captures the tables each select().from() ran against so the test can assert
// the comments query was skipped (no active PRs) or issued with the right
// issue-id scope.
function createCapturingDb(fixtures: Parameters<typeof createMockDb>[0]): {
  db: Db;
  queriedTables: unknown[];
  whereConditions: Array<{ table: unknown; condition: unknown }>;
} {
  const queriedTables: unknown[] = [];
  const whereConditions: Array<{ table: unknown; condition: unknown }> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        queriedTables.push(table);
        const queryChain: Record<string, unknown> = {
          innerJoin: vi.fn(() => queryChain),
          leftJoin: vi.fn(() => queryChain),
          where: vi.fn((condition: unknown) => {
            whereConditions.push({ table, condition });
            return queryChain;
          }),
          limit: vi.fn(() => queryChain),
          then: (resolve: (val: unknown) => void) => {
            if (table === agents) return resolve(fixtures.agents ?? []);
            if (table === issues) return resolve(fixtures.reviews ?? []);
            if (table === issueWorkProducts) return resolve(fixtures.products ?? []);
            if (table === issueComments) return resolve(fixtures.comments ?? []);
            if (table === connectionEventDeliveries) return resolve(fixtures.deliveries ?? []);
            if (table === instanceSettings) return resolve(fixtures.instanceSettings ?? []);
            if (table === heartbeatRunEvents) return resolve(fixtures.garbageEvents ?? []);
            return resolve(fixtures.latestMerged ?? [{ mergedAt: null }]);
          },
        };
        return queryChain;
      }),
    })),
  };
  return { db: db as unknown as Db, queriedTables, whereConditions };
}

// Drizzle conditions form a tree of plain objects: and(...) carries operands in
// queryChunks, inArray keeps its raw values on the node, isNull embeds the
// Column instance. Walking every property generically avoids pinning internal
// AST class names; string values plus Column nodes are all the assertions need.
function collectConditionParts(condition: unknown): { values: Set<string>; columns: Set<object> } {
  const values = new Set<string>();
  const columns = new Set<object>();
  const visit = (node: unknown, seen: Set<object>): void => {
    if (typeof node === "string") {
      values.add(node);
      return;
    }
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if ("table" in node && "name" in node) columns.add(node);
    const record = node as Record<string, unknown>;
    for (const part of Object.values(record)) {
      if (Array.isArray(part)) {
        for (const item of part) visit(item, seen);
      } else {
        visit(part, seen);
      }
    }
  };
  visit(condition, new Set());
  return { values, columns };
}

describe("collectDevflowHealth verdict comments scoping (OPE-12784)", () => {
  it("does not query issueComments when no issue has an active PR", async () => {
    const { db, queriedTables } = createCapturingDb({ products: [] });

    await collectDevflowHealth(db, companyId, now);

    expect(queriedTables).not.toContain(issueComments);
  });

  it("scopes the comments query to issues with active PRs", async () => {
    const prIssueId = "issue-with-pr";
    const otherIssueId = "issue-without-pr";
    const { db, whereConditions } = createCapturingDb({
      products: [
        {
          product: {
            id: "prod-1",
            status: "open",
            type: "pull_request",
            provider: "github",
            externalId: "301",
            createdAt: new Date("2026-10-27T16:00:00Z"),
            metadata: { repo: "itkadr-git/myrmidon", number: 301 },
          },
          issue: { id: prIssueId, title: "Active PR task", status: "in_review" },
        },
      ],
      comments: [
        { issueId: prIssueId, body: "APPROVE PR #301", createdAt: new Date("2026-10-27T17:00:00Z") },
        { issueId: otherIssueId, body: "verdict on unrelated issue", createdAt: new Date("2026-10-27T17:00:00Z") },
      ],
    });

    await collectDevflowHealth(db, companyId, now);

    const commentsWhere = whereConditions.find(({ table }) => table === issueComments);
    expect(commentsWhere).toBeDefined();
    const parts = collectConditionParts(commentsWhere?.condition);
    expect(parts.values.has(prIssueId)).toBe(true);
    expect(parts.values.has(otherIssueId)).toBe(false);
    expect(parts.columns.has(issueComments.deletedAt)).toBe(true);
  });

  it("excludes merged PR issues from the comments query scope", async () => {
    const activeIssueId = "issue-active-pr";
    const mergedIssueId = "issue-merged-pr";
    const { db, whereConditions } = createCapturingDb({
      products: [
        {
          product: {
            id: "prod-active",
            status: "open",
            type: "pull_request",
            provider: "github",
            externalId: "302",
            createdAt: new Date("2026-10-27T16:00:00Z"),
            metadata: { number: 302 },
          },
          issue: { id: activeIssueId, title: "Active PR task", status: "in_review" },
        },
        {
          product: {
            id: "prod-merged",
            status: "merged",
            type: "pull_request",
            provider: "github",
            externalId: "303",
            createdAt: new Date("2026-10-27T16:00:00Z"),
            metadata: { number: 303 },
          },
          issue: { id: mergedIssueId, title: "Merged PR task", status: "done" },
        },
      ],
      comments: [{ issueId: activeIssueId, body: "APPROVE PR #302", createdAt: new Date("2026-10-27T17:00:00Z") }],
    });

    await collectDevflowHealth(db, companyId, now);

    const commentsWhere = whereConditions.find(({ table }) => table === issueComments);
    expect(commentsWhere).toBeDefined();
    const parts = collectConditionParts(commentsWhere?.condition);
    expect(parts.values.has(activeIssueId)).toBe(true);
    expect(parts.values.has(mergedIssueId)).toBe(false);
  });
});
