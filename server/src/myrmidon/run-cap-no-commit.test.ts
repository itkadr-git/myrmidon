import { describe, expect, it } from "vitest";
import {
  buildRunCapNoCommitBlockedPatch,
  buildRunCapNoCommitComment,
  countRunsWithoutCommit,
  extractRunHeadSha,
  extractRunSummary,
  resolveTaskRunsWithoutCommitLimit,
  DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT,
  RUN_CAP_NO_COMMIT_BLOCK_REASON,
  RUN_CAP_NO_COMMIT_UNBLOCK_ACTION,
  type RunCommitObservation,
} from "./run-cap-no-commit.js";

describe("countRunsWithoutCommit", () => {
  const currentHeadSha = "abc1234567890";

  it("returns 0 if currentHeadSha is null (no PR)", () => {
    const runs: RunCommitObservation[] = [
      {
        runId: "run-1",
        status: "succeeded",
        headSha: "abc1234567890",
        createdAt: new Date(),
        summary: "done something",
      },
    ];
    const res = countRunsWithoutCommit(runs, null);
    expect(res.count).toBe(0);
    expect(res.lastSummaries).toEqual([]);
  });

  it("counts consecutive runs matching currentHeadSha", () => {
    const runs: RunCommitObservation[] = [
      {
        runId: "run-3",
        status: "succeeded",
        headSha: currentHeadSha,
        createdAt: new Date(3000),
        summary: "Summary 3",
      },
      {
        runId: "run-2",
        status: "failed",
        headSha: currentHeadSha,
        createdAt: new Date(2000),
        summary: "Summary 2",
      },
      {
        runId: "run-1",
        status: "succeeded",
        headSha: currentHeadSha,
        createdAt: new Date(1000),
        summary: "Summary 1",
      },
    ];
    const res = countRunsWithoutCommit(runs, currentHeadSha);
    expect(res.count).toBe(3);
    expect(res.lastSummaries).toEqual(["Summary 3", "Summary 2", "Summary 1"]);
  });

  it("stops counting as soon as headSha differs (new commit was made between runs)", () => {
    const runs: RunCommitObservation[] = [
      {
        runId: "run-4",
        status: "succeeded",
        headSha: currentHeadSha,
        createdAt: new Date(4000),
        summary: "Summary 4",
      },
      {
        runId: "run-3",
        status: "succeeded",
        headSha: currentHeadSha,
        createdAt: new Date(3000),
        summary: "Summary 3",
      },
      {
        runId: "run-2",
        status: "succeeded",
        headSha: "older-sha-12345", // previous commit!
        createdAt: new Date(2000),
        summary: "Summary 2 (older commit)",
      },
      {
        runId: "run-1",
        status: "succeeded",
        headSha: "older-sha-12345",
        createdAt: new Date(1000),
        summary: "Summary 1",
      },
    ];
    const res = countRunsWithoutCommit(runs, currentHeadSha);
    expect(res.count).toBe(2);
    expect(res.lastSummaries).toEqual(["Summary 4", "Summary 3"]);
  });

  it("stops counting if a run has null headSha", () => {
    const runs: RunCommitObservation[] = [
      {
        runId: "run-2",
        status: "succeeded",
        headSha: currentHeadSha,
        createdAt: new Date(2000),
        summary: "Summary 2",
      },
      {
        runId: "run-1",
        status: "succeeded",
        headSha: null,
        createdAt: new Date(1000),
        summary: "Summary 1",
      },
    ];
    const res = countRunsWithoutCommit(runs, currentHeadSha);
    expect(res.count).toBe(1);
    expect(res.lastSummaries).toEqual(["Summary 2"]);
  });
});

describe("buildRunCapNoCommitBlockedPatch", () => {
  it("builds the expected blocker structure", () => {
    const now = new Date("2026-11-14T12:00:00.000Z");
    const patch = buildRunCapNoCommitBlockedPatch({
      agentId: "agent-1",
      count: 4,
      limit: 4,
      headSha: "deadbeef12345678",
      now,
    });

    expect(patch.status).toBe("blocked");
    expect(patch.blockerMetadata).toEqual({
      owner: { agentId: "agent-1" },
      blockReason: RUN_CAP_NO_COMMIT_BLOCK_REASON,
      externalRef: "run_cap_no_commit:deadbeef12345678:4",
      nextCheckAt: "2026-11-15T12:00:00.000Z",
      timeoutAt: "2026-11-15T12:00:00.000Z",
      escalationPolicy: "escalate_to_manager",
    });
    expect(patch.unblockDescriptor).toEqual({
      owner: { agentId: "agent-1" },
      action: RUN_CAP_NO_COMMIT_UNBLOCK_ACTION,
    });
  });
});

describe("buildRunCapNoCommitComment", () => {
  it("formats comment with count, sha, and summaries", () => {
    const comment = buildRunCapNoCommitComment({
      count: 4,
      limit: 4,
      headSha: "abcdef1234567890",
      lastSummaries: ["Summary 4", "Summary 3", "Summary 2", "Summary 1"],
    });

    expect(comment).toContain("4 прогонов без нового коммита");
    expect(comment).toContain("голова PR: abcdef12");
    expect(comment).toContain("- Summary 4");
    expect(comment).toContain("- Summary 3");
    expect(comment).toContain("Счётчик сбрасывается при новом коммите");
  });
});

describe("extractRunHeadSha and extractRunSummary", () => {
  it("extracts headSha from contextSnapshot.prHeadSha", () => {
    const run: any = {
      contextSnapshot: { prHeadSha: "sha123" },
      resultJson: null,
    };
    expect(extractRunHeadSha(run)).toBe("sha123");
  });

  it("extracts headSha from resultJson.prHeadSha", () => {
    const run: any = {
      contextSnapshot: {},
      resultJson: { prHeadSha: "sha456" },
    };
    expect(extractRunHeadSha(run)).toBe("sha456");
  });

  it("extracts headSha from wake payload pullRequestsCi", () => {
    const run: any = {
      contextSnapshot: {
        paperclipWake: {
          pullRequestsCi: [{ headSha: "sha789" }],
        },
      },
      resultJson: null,
    };
    expect(extractRunHeadSha(run)).toBe("sha789");
  });

  it("extracts summary from resultJson or contextSnapshot", () => {
    const run1: any = {
      resultJson: { summary: "Result summary text" },
      contextSnapshot: {},
    };
    expect(extractRunSummary(run1)).toBe("Result summary text");

    const run2: any = {
      resultJson: null,
      contextSnapshot: { summary: "Context summary text" },
    };
    expect(extractRunSummary(run2)).toBe("Context summary text");

    const run3: any = {
      resultJson: null,
      contextSnapshot: null,
      error: "Error message",
    };
    expect(extractRunSummary(run3)).toBe("Error message");
  });
});

describe("resolveTaskRunsWithoutCommitLimit", () => {
  it("defaults to 4 when nothing is stored or input is null/empty", () => {
    expect(resolveTaskRunsWithoutCommitLimit({})).toBe(DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT);
    expect(resolveTaskRunsWithoutCommitLimit(null)).toBe(DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT);
    expect(resolveTaskRunsWithoutCommitLimit({ processes: {} })).toBe(DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT);
    expect(resolveTaskRunsWithoutCommitLimit({ processes: "invalid" })).toBe(DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT);
  });

  it("handles 0 to disable", () => {
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: 0 } })).toBe(0);
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: "0" } })).toBe(0);
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: -5 } })).toBe(0);
  });

  it("accepts valid positive numbers and numeric strings, clamping at 100", () => {
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: 10 } })).toBe(10);
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: "15" } })).toBe(15);
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: 500 } })).toBe(100);
  });

  it("falls back to default on invalid non-numeric values", () => {
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: "invalid" } })).toBe(
      DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT,
    );
    expect(resolveTaskRunsWithoutCommitLimit({ processes: { taskRunsWithoutCommitLimit: true } })).toBe(
      DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT,
    );
  });
});
