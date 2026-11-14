import { describe, expect, it, vi } from "vitest";
import {
  type ExecutorCommentOnWaitingReviewFacts,
  isExecutorCommentOnWaitingReview,
  isReviewCiWaitMonitorArmed,
  readReviewAdmissionDecision,
  readReviewCommentWakeGateEnabled,
  REVIEW_COMMENT_WAKE_GATE_ENABLED_ENV,
} from "./comment-wake-gate.js";
import { REVIEW_CI_WAIT_MONITOR_SERVICE_NAME, type ReviewPullRequestCiFacts } from "./policy.js";
import type { ReviewHeadFailedChecks } from "./github-ci.js";

// myrmidon(EMPTY-RUNS-2): the pure half of the comment wake gate. The route
// half (both comment paths of routes/issues.ts) is covered in
// server/src/__tests__/issue-comment-reopen-routes.test.ts.

const ENGINEER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEWER_ID = "33333333-3333-4333-8333-333333333333";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";
const PR_URL = "https://github.com/acme/app/pull/7";
const HEAD = "a".repeat(40);

const armedPolicy = {
  mode: "normal",
  stages: [],
  monitor: { serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME, kind: "external_service" },
};

/** The executor's plain comment on a task whose review stage waits for its admission wake. */
function facts(overrides: Partial<ExecutorCommentOnWaitingReviewFacts> = {}): ExecutorCommentOnWaitingReviewFacts {
  return {
    issueStatus: "in_review",
    executionState: {
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: REVIEWER_ID },
      returnAssignee: { type: "agent", agentId: ENGINEER_ID },
    },
    executionPolicy: armedPolicy,
    monitorNextCheckAt: new Date("2026-11-13T07:40:20.000Z"),
    recipientAgentId: REVIEWER_ID,
    authorType: "agent",
    authorAgentId: ENGINEER_ID,
    reopened: false,
    resumeRequested: false,
    ...overrides,
  };
}

describe("isReviewCiWaitMonitorArmed", () => {
  it("is armed when the policy carries the Review CI wait monitor and a next check is scheduled", () => {
    expect(
      isReviewCiWaitMonitorArmed({ executionPolicy: armedPolicy, monitorNextCheckAt: new Date() }),
    ).toBe(true);
    expect(
      isReviewCiWaitMonitorArmed({ executionPolicy: armedPolicy, monitorNextCheckAt: "2026-11-13T07:40:20.000Z" }),
    ).toBe(true);
  });

  it("is not armed without a scheduled next check", () => {
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: armedPolicy, monitorNextCheckAt: null })).toBe(false);
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: armedPolicy, monitorNextCheckAt: undefined })).toBe(false);
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: armedPolicy, monitorNextCheckAt: "" })).toBe(false);
  });

  it("is not armed for another monitor, a cleared monitor or an unreadable policy", () => {
    const at = new Date();
    expect(
      isReviewCiWaitMonitorArmed({
        executionPolicy: { stages: [], monitor: { serviceName: "GitHub CI pending monitor" } },
        monitorNextCheckAt: at,
      }),
    ).toBe(false);
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: { stages: [], monitor: null }, monitorNextCheckAt: at })).toBe(false);
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: { stages: [] }, monitorNextCheckAt: at })).toBe(false);
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: null, monitorNextCheckAt: at })).toBe(false);
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: "not a policy", monitorNextCheckAt: at })).toBe(false);
    expect(isReviewCiWaitMonitorArmed({ executionPolicy: [armedPolicy], monitorNextCheckAt: at })).toBe(false);
  });
});

describe("isExecutorCommentOnWaitingReview", () => {
  it("recognises the executor's comment on a review stage that waits for its admission wake", () => {
    expect(isExecutorCommentOnWaitingReview(facts())).toBe(true);
  });

  it("does not hold a person's comment", () => {
    expect(isExecutorCommentOnWaitingReview(facts({ authorType: "user", authorAgentId: null }))).toBe(false);
  });

  it("does not hold a comment of an agent that is not the executor (a lead's instruction)", () => {
    expect(isExecutorCommentOnWaitingReview(facts({ authorAgentId: LEAD_ID }))).toBe(false);
  });

  it("does not hold an agent comment without an agent id", () => {
    expect(isExecutorCommentOnWaitingReview(facts({ authorAgentId: null }))).toBe(false);
  });

  it("does not hold a comment once the reviewer was admitted (no armed monitor)", () => {
    expect(isExecutorCommentOnWaitingReview(facts({ monitorNextCheckAt: null }))).toBe(false);
    expect(
      isExecutorCommentOnWaitingReview(facts({ executionPolicy: { mode: "normal", stages: [], monitor: null } })),
    ).toBe(false);
    expect(
      isExecutorCommentOnWaitingReview(
        facts({ executionPolicy: { mode: "normal", stages: [], monitor: { serviceName: "CI" } } }),
      ),
    ).toBe(false);
  });

  it("does not hold a comment on a task that is not in review", () => {
    for (const issueStatus of ["in_progress", "todo", "blocked", "done", null, undefined]) {
      expect(isExecutorCommentOnWaitingReview(facts({ issueStatus }))).toBe(false);
    }
  });

  it("does not hold a comment without a pending review stage", () => {
    expect(isExecutorCommentOnWaitingReview(facts({ executionState: null }))).toBe(false);
    expect(isExecutorCommentOnWaitingReview(facts({ executionState: undefined }))).toBe(false);
    for (const status of ["changes_requested", "completed", "idle"]) {
      expect(
        isExecutorCommentOnWaitingReview(
          facts({ executionState: { ...facts().executionState, status } }),
        ),
      ).toBe(false);
    }
    expect(
      isExecutorCommentOnWaitingReview(
        facts({ executionState: { ...facts().executionState, currentStageType: "approval" } }),
      ),
    ).toBe(false);
  });

  it("does not hold a wake that would not go to the stage participant", () => {
    expect(isExecutorCommentOnWaitingReview(facts({ recipientAgentId: LEAD_ID }))).toBe(false);
    expect(isExecutorCommentOnWaitingReview(facts({ recipientAgentId: null }))).toBe(false);
    expect(
      isExecutorCommentOnWaitingReview(
        facts({
          executionState: {
            ...facts().executionState,
            currentParticipant: { type: "user", userId: "local-board" },
          },
        }),
      ),
    ).toBe(false);
    expect(
      isExecutorCommentOnWaitingReview(
        facts({ executionState: { ...facts().executionState, currentParticipant: null } }),
      ),
    ).toBe(false);
  });

  it("does not hold a comment when the stage has no agent executor to match the author", () => {
    expect(
      isExecutorCommentOnWaitingReview(
        facts({ executionState: { ...facts().executionState, returnAssignee: null } }),
      ),
    ).toBe(false);
    expect(
      isExecutorCommentOnWaitingReview(
        facts({
          executionState: { ...facts().executionState, returnAssignee: { type: "user", userId: "local-board" } },
        }),
      ),
    ).toBe(false);
  });

  it("does not hold the participant's own comment", () => {
    expect(
      isExecutorCommentOnWaitingReview(
        facts({
          authorAgentId: REVIEWER_ID,
          executionState: {
            ...facts().executionState,
            returnAssignee: { type: "agent", agentId: REVIEWER_ID },
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not hold an explicit resume or a comment that reopened the issue", () => {
    expect(isExecutorCommentOnWaitingReview(facts({ resumeRequested: true }))).toBe(false);
    expect(isExecutorCommentOnWaitingReview(facts({ reopened: true }))).toBe(false);
  });
});

describe("readReviewAdmissionDecision", () => {
  function reads(ci: ReviewPullRequestCiFacts, failed: ReviewHeadFailedChecks = { state: "unknown", reason: "not_read" }) {
    const resolveCi = vi.fn(async () => ci);
    const resolveHeadFailedChecks = vi.fn(async () => failed);
    return { resolveCi, resolveHeadFailedChecks };
  }

  const base = { companyId: "company-1", issueId: "issue-1", critical: false };

  it("admits a critical issue without reading CI", async () => {
    const r = reads({ state: "pending", pullRequestUrl: PR_URL, headSha: HEAD });
    await expect(readReviewAdmissionDecision({ ...base, critical: true, ...r })).resolves.toBe("admit");
    expect(r.resolveCi).not.toHaveBeenCalled();
    expect(r.resolveHeadFailedChecks).not.toHaveBeenCalled();
  });

  it("waits for CI while the head CI is pending", async () => {
    const r = reads({ state: "pending", pullRequestUrl: PR_URL, headSha: HEAD });
    await expect(readReviewAdmissionDecision({ ...base, ...r })).resolves.toBe("wait_for_ci");
    expect(r.resolveCi).toHaveBeenCalledWith({ companyId: "company-1", issueId: "issue-1" });
    expect(r.resolveHeadFailedChecks).not.toHaveBeenCalled();
  });

  it("waits for CI when the head CI cannot be read, like the status path", async () => {
    const r = reads({ state: "unknown", pullRequestUrl: PR_URL, headSha: null, reason: "pull:http_403" });
    await expect(readReviewAdmissionDecision({ ...base, ...r })).resolves.toBe("wait_for_ci");
    expect(r.resolveHeadFailedChecks).not.toHaveBeenCalled();
  });

  it("waits for the fix when the final check of the head failed, without a second read", async () => {
    const r = reads({ state: "complete", pullRequestUrl: PR_URL, headSha: HEAD, finalCheckConclusion: "failure" });
    await expect(readReviewAdmissionDecision({ ...base, ...r })).resolves.toBe("wait_red");
    expect(r.resolveHeadFailedChecks).not.toHaveBeenCalled();
  });

  it("admits when the final check of the head succeeded, without a second read", async () => {
    const r = reads({ state: "complete", pullRequestUrl: PR_URL, headSha: HEAD, finalCheckConclusion: "success" });
    await expect(readReviewAdmissionDecision({ ...base, ...r })).resolves.toBe("admit");
    expect(r.resolveHeadFailedChecks).not.toHaveBeenCalled();
  });

  it("reads the failed checks of a finished head that carries no final verdict", async () => {
    const red = reads(
      { state: "complete", pullRequestUrl: PR_URL, headSha: HEAD },
      { state: "ok", headSha: HEAD, pullRequestUrl: PR_URL, failed: ["tests (server 3/6)"] },
    );
    await expect(readReviewAdmissionDecision({ ...base, ...red })).resolves.toBe("wait_red");
    expect(red.resolveHeadFailedChecks).toHaveBeenCalledWith({
      companyId: "company-1",
      issueId: "issue-1",
      headSha: HEAD,
    });

    const green = reads(
      { state: "complete", pullRequestUrl: PR_URL, headSha: HEAD },
      { state: "ok", headSha: HEAD, pullRequestUrl: PR_URL, failed: [] },
    );
    await expect(readReviewAdmissionDecision({ ...base, ...green })).resolves.toBe("admit");
  });

  it("treats an unreadable or moved-head failed list of a finished head as green, like the status path", async () => {
    const unreadable = reads({ state: "complete", pullRequestUrl: PR_URL, headSha: HEAD });
    await expect(readReviewAdmissionDecision({ ...base, ...unreadable })).resolves.toBe("admit");

    const movedHead = reads(
      { state: "complete", pullRequestUrl: PR_URL, headSha: HEAD },
      { state: "ok", headSha: "b".repeat(40), pullRequestUrl: PR_URL, failed: ["checks"] },
    );
    await expect(readReviewAdmissionDecision({ ...base, ...movedHead })).resolves.toBe("admit");
  });

  it("admits when there is no pull request or no hosted CI to wait for", async () => {
    const noPr = reads({ state: "no_pull_request", pullRequestUrl: null, headSha: null });
    await expect(readReviewAdmissionDecision({ ...base, ...noPr })).resolves.toBe("admit");
    const noCi = reads({ state: "not_configured", pullRequestUrl: PR_URL, headSha: HEAD });
    await expect(readReviewAdmissionDecision({ ...base, ...noCi })).resolves.toBe("admit");
  });
});

describe("readReviewCommentWakeGateEnabled", () => {
  const env = (value: string | undefined) =>
    (value === undefined ? {} : { [REVIEW_COMMENT_WAKE_GATE_ENABLED_ENV]: value }) as NodeJS.ProcessEnv;

  it("is on when the variable is unset, empty or anything but an explicit off", () => {
    expect(REVIEW_COMMENT_WAKE_GATE_ENABLED_ENV).toBe("MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED");
    for (const value of [undefined, "", "  ", "1", "true", "on", "yes", "maybe"]) {
      expect(readReviewCommentWakeGateEnabled(env(value)), JSON.stringify(value)).toBe(true);
    }
  });

  it("is off only for an explicit off value, whatever its case or padding", () => {
    for (const value of ["0", "false", "off", "no", "OFF", " False "]) {
      expect(readReviewCommentWakeGateEnabled(env(value)), JSON.stringify(value)).toBe(false);
    }
  });
});
