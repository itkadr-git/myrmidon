import { describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_RESUME_MARGIN_MS,
  decideWakeCiGate,
  isWakeCiGatedReason,
  readWakeCiUnreadyGateEnabled,
  type WakeCiGateDeps,
  type WakeCiGateIssue,
} from "../myrmidon/wake-ci-unready-gate.js";

const COMPANY = "company-1";
const REVIEWER = "agent-reviewer";
const ENGINEER = "agent-engineer";

function reviewIssue(over: Partial<WakeCiGateIssue> = {}): WakeCiGateIssue {
  return {
    id: "issue-1",
    status: "in_review",
    priority: "medium",
    assigneeAgentId: ENGINEER,
    executionState: {
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: REVIEWER },
      returnAssignee: { type: "agent", agentId: ENGINEER },
    },
    ...over,
  };
}

function engineerIssue(over: Partial<WakeCiGateIssue> = {}): WakeCiGateIssue {
  return { id: "issue-2", status: "in_progress", priority: "medium", assigneeAgentId: ENGINEER, executionState: null, ...over };
}

function deps(over: Partial<WakeCiGateDeps> = {}): WakeCiGateDeps {
  return {
    resolveCi: vi.fn(async () => ({ state: "complete" as const, pullRequestUrl: "u", headSha: "abc", finalCheckConclusion: "success" })),
    engineerWaitsForOwnPrCi: vi.fn(async () => false),
    isRateLimited: () => false,
    rateLimitResetEpochSeconds: () => null,
    ...over,
  };
}

const REVIEWER_REASONS = ["idle_pickup", "execution_review_participant_recovery", "execution_review_requested"];

describe("wake CI-unready gate: reviewer", () => {
  it.each(REVIEWER_REASONS)("does not wake the reviewer (%s) while the head CI is pending", async (reason) => {
    const d = deps({ resolveCi: vi.fn(async () => ({ state: "pending" as const, pullRequestUrl: "u", headSha: "abc" })) });
    const decision = await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason, issue: reviewIssue() }, d);
    expect(decision).toMatchObject({ action: "defer", role: "reviewer", cause: "ci_pending" });
  });

  it.each(REVIEWER_REASONS)("wakes the reviewer (%s) once the head CI is complete", async (reason) => {
    const decision = await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason, issue: reviewIssue() }, deps());
    expect(decision).toEqual({ action: "admit" });
  });

  it("does not wake the reviewer under a GitHub rate limit and resumes at reset + 60 s", async () => {
    const reset = Math.floor(Date.parse("2026-11-16T10:00:00Z") / 1000);
    const resolveCi = vi.fn();
    const d = deps({ isRateLimited: () => true, rateLimitResetEpochSeconds: () => reset, resolveCi });
    const decision = await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason: "idle_pickup", issue: reviewIssue() }, d);
    expect(decision).toEqual({
      action: "defer",
      role: "reviewer",
      cause: "rate_limited",
      resumeAt: new Date(reset * 1000 + RATE_LIMIT_RESUME_MARGIN_MS),
    });
    expect(RATE_LIMIT_RESUME_MARGIN_MS).toBe(60_000);
    expect(resolveCi).not.toHaveBeenCalled();
  });

  it("wakes the reviewer after the limit is reset", async () => {
    let limited = true;
    const d = deps({ isRateLimited: () => limited, rateLimitResetEpochSeconds: () => (limited ? 1 : null) });
    const input = { agentId: REVIEWER, companyId: COMPANY, reason: "execution_review_participant_recovery", issue: reviewIssue() };
    expect((await decideWakeCiGate(input, d)).action).toBe("defer");
    limited = false;
    expect(await decideWakeCiGate(input, d)).toEqual({ action: "admit" });
  });

  it("defers when the read answers a rate limit after the first check", async () => {
    const d = deps({
      resolveCi: vi.fn(async () => ({
        state: "unknown" as const, pullRequestUrl: "u", headSha: null, reason: "skipped_rate_limited",
        rateLimit: { remaining: 0, limit: 5000, resetEpochSeconds: 1 },
      })),
      rateLimitResetEpochSeconds: () => 100,
    });
    const decision = await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason: "idle_pickup", issue: reviewIssue() }, d);
    expect(decision).toMatchObject({ action: "defer", cause: "rate_limited", resumeAt: new Date(100_000 + 60_000) });
  });

  it("defers when the CI cannot be read or the read throws", async () => {
    const unknown = deps({ resolveCi: vi.fn(async () => ({ state: "unknown" as const, pullRequestUrl: "u", headSha: null, reason: "read_failed" })) });
    expect(await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason: "idle_pickup", issue: reviewIssue() }, unknown))
      .toMatchObject({ action: "defer", cause: "ci_unreadable", resumeAt: null });
    const throwing = deps({ resolveCi: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason: "idle_pickup", issue: reviewIssue() }, throwing))
      .toMatchObject({ action: "defer", cause: "ci_unreadable" });
  });

  it("admits a critical task and a task without a pull request", async () => {
    const pending = deps({ resolveCi: vi.fn(async () => ({ state: "pending" as const, pullRequestUrl: "u", headSha: "a" })) });
    expect(await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason: "idle_pickup", issue: reviewIssue({ priority: "critical" }) }, pending))
      .toEqual({ action: "admit" });
    const none = deps({ resolveCi: vi.fn(async () => ({ state: "no_pull_request" as const, pullRequestUrl: null, headSha: null })) });
    expect(await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason: "idle_pickup", issue: reviewIssue() }, none))
      .toEqual({ action: "admit" });
  });

  it("does not gate ci_completed", async () => {
    expect(isWakeCiGatedReason("ci_completed")).toBe(false);
    const pending = deps({ resolveCi: vi.fn(async () => ({ state: "pending" as const, pullRequestUrl: "u", headSha: "a" })) });
    // Even if it were asked, a reason outside both sets is admitted without a read.
    expect(await decideWakeCiGate({ agentId: REVIEWER, companyId: COMPANY, reason: "ci_completed", issue: reviewIssue() }, pending))
      .toEqual({ action: "admit" });
    expect(pending.resolveCi).not.toHaveBeenCalled();
  });

  it("does not gate another agent that is not the stage participant", async () => {
    const pending = deps({ resolveCi: vi.fn(async () => ({ state: "pending" as const, pullRequestUrl: "u", headSha: "a" })) });
    expect(await decideWakeCiGate({ agentId: "someone-else", companyId: COMPANY, reason: "idle_pickup", issue: reviewIssue() }, pending))
      .toEqual({ action: "admit" });
  });
});

describe("wake CI-unready gate: engineer", () => {
  it.each(["in_progress_no_run", "issue_continuation_needed", "idle_pickup"])(
    "does not wake an in_progress engineer (%s) while its PR waits for CI",
    async (reason) => {
      const d = deps({ engineerWaitsForOwnPrCi: vi.fn(async () => true) });
      const decision = await decideWakeCiGate({ agentId: ENGINEER, companyId: COMPANY, reason, issue: engineerIssue() }, d);
      expect(decision).toMatchObject({ action: "defer", role: "engineer", cause: "ci_pending" });
      expect(d.engineerWaitsForOwnPrCi).toHaveBeenCalledWith(COMPANY, "issue-2");
    },
  );

  it("wakes the engineer when its PR does not wait for CI", async () => {
    expect(await decideWakeCiGate({ agentId: ENGINEER, companyId: COMPANY, reason: "in_progress_no_run", issue: engineerIssue() }, deps()))
      .toEqual({ action: "admit" });
  });

  it("wakes the engineer on ci_completed even when the stored state still says pending", async () => {
    const d = deps({ engineerWaitsForOwnPrCi: vi.fn(async () => true) });
    expect(await decideWakeCiGate({ agentId: ENGINEER, companyId: COMPANY, reason: "ci_completed", issue: engineerIssue() }, d))
      .toEqual({ action: "admit" });
    expect(d.engineerWaitsForOwnPrCi).not.toHaveBeenCalled();
  });

  it("does not gate a task that is not in_progress or not assigned to the agent", async () => {
    const d = deps({ engineerWaitsForOwnPrCi: vi.fn(async () => true) });
    expect(await decideWakeCiGate({ agentId: ENGINEER, companyId: COMPANY, reason: "in_progress_no_run", issue: engineerIssue({ status: "todo" }) }, d))
      .toEqual({ action: "admit" });
    expect(await decideWakeCiGate({ agentId: "other", companyId: COMPANY, reason: "in_progress_no_run", issue: engineerIssue() }, d))
      .toEqual({ action: "admit" });
  });

  it("admits when the stored-state read fails", async () => {
    const d = deps({ engineerWaitsForOwnPrCi: vi.fn(async () => { throw new Error("db"); }) });
    expect(await decideWakeCiGate({ agentId: ENGINEER, companyId: COMPANY, reason: "in_progress_no_run", issue: engineerIssue() }, d))
      .toEqual({ action: "admit" });
  });
});

describe("wake CI-unready gate switch", () => {
  it("is on unless explicitly off", () => {
    expect(readWakeCiUnreadyGateEnabled({})).toBe(true);
    expect(readWakeCiUnreadyGateEnabled({ MYRMIDON_WAKE_CI_UNREADY_GATE_ENABLED: "off" })).toBe(false);
  });
});
