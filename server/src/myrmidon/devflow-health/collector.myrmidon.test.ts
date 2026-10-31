import { describe, expect, it, vi } from "vitest";
import {
  agents,
  connectionEventDeliveries,
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
});
