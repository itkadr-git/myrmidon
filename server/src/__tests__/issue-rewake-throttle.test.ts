import { describe, expect, it } from "vitest";
import {
  ISSUE_REWAKE_BASE_COOLDOWN_MS,
  ISSUE_REWAKE_MAX_COOLDOWN_MS,
  ISSUE_REWAKE_NO_PROGRESS_THRESHOLD,
  computeIssueRewakeCooldownMs,
  evaluateIssueRewakeThrottle,
  isIssueProgressActivity,
  isThrottleCandidateIssueRewake,
} from "../services/issue-rewake-throttle.ts";

const NOW = new Date("2026-07-12T18:14:00.000Z");

function runSample(input: {
  id: string;
  status?: string;
  finishedSecondsAgo: number;
  errorCode?: string | null;
}) {
  return {
    id: input.id,
    status: input.status ?? "succeeded",
    errorCode: input.errorCode ?? null,
    finishedAt: new Date(NOW.getTime() - input.finishedSecondsAgo * 1000),
  };
}

describe("isThrottleCandidateIssueRewake", () => {
  const base = {
    reason: "issue_assigned",
    wakeCommentId: null,
    requestedByActorType: "system" as const,
    forceFreshSession: false,
    hasExplicitResume: false,
  };

  it("throttles state-poll reasons and reason-less invokes", () => {
    expect(isThrottleCandidateIssueRewake(base)).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_continuation_needed" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_state_guard_mismatch" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "execution_reconciliation_required" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "transient_failure_retry" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "task_ticker" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "task-ticker" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_assignment_recovery" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_graph_liveness_backstop" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: null })).toBe(true);
  });

  it("throttles automatic loop-forming wake reasons (OPE-10582 п.2)", () => {
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "swarm_matched" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "idle_pickup" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_disposition_repair" })).toBe(true);
  });

  it("keeps agent comments throttle-eligible without granting human comment privileges", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
    })).toBe(true);
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "user",
    })).toBe(false);
  });

  it("never throttles trusted explicit escalation wakes", () => {
    expect(isThrottleCandidateIssueRewake({ ...base, forceFreshSession: true })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, hasExplicitResume: true })).toBe(false);
  });

  it("keeps agent-authored explicit resume comments throttle-eligible", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_reopened_via_comment",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
      hasExplicitResume: true,
    })).toBe(true);
  });

  it("passes event-shaped wake reasons through", () => {
    for (const reason of [
      "issue_commented",
      "issue_comment_mentioned",
      "issue_blockers_resolved",
      "issue_children_completed",
      "issue_monitor_due",
      "process_lost_retry",
      "run_liveness_continuation",
    ]) {
      expect(isThrottleCandidateIssueRewake({ ...base, reason })).toBe(false);
    }
  });
});

describe("computeIssueRewakeCooldownMs", () => {
  it("starts at the base cooldown and doubles per extra no-progress run, capped", () => {
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 1)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 2);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 3)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 8);
    expect(computeIssueRewakeCooldownMs(100)).toBe(ISSUE_REWAKE_MAX_COOLDOWN_MS);
  });
});

describe("evaluateIssueRewakeThrottle", () => {
  it("freezes after two consecutive stale queued cancellations, even after cooldown and with a high configured threshold", () => {
    const stale = (id: string, finishedSecondsAgo: number) => runSample({
      id, status: "cancelled", errorCode: "queued_run_stale_timeout", finishedSecondsAgo,
    });
    const input = {
      now: NOW,
      freezeThreshold: 99,
      runIdsWithIssueProgress: new Set<string>(),
      hasNewIssueInputSinceLastRun: false,
    };
    expect(isThrottleCandidateIssueRewake({
      reason: "queued_run_stale_timeout", wakeCommentId: null,
      requestedByActorType: "system", forceFreshSession: false, hasExplicitResume: false,
    })).toBe(true);
    expect(evaluateIssueRewakeThrottle({ ...input, recentTerminalRuns: [stale("r1", 7200)] }))
      .toEqual({ blocked: false, noProgressStreak: 0 });
    expect(evaluateIssueRewakeThrottle({ ...input, recentTerminalRuns: [stale("r2", 3600), stale("r1", 7200)] }))
      .toEqual({ blocked: true, frozen: true, noProgressStreak: 2,
        frozenAt: new Date(NOW.getTime() - 3600_000) });
    expect(evaluateIssueRewakeThrottle({ ...input,
      recentTerminalRuns: [runSample({ id: "success", finishedSecondsAgo: 1 }), stale("r2", 3600), stale("r1", 7200)],
    })).toEqual({ blocked: false, noProgressStreak: 1 });
    expect(evaluateIssueRewakeThrottle({ ...input,
      recentTerminalRuns: [stale("r3", 1), runSample({ id: "other", status: "cancelled", finishedSecondsAgo: 2 }), stale("r2", 3600)],
    })).toEqual({ blocked: false, noProgressStreak: 0 });
    expect(evaluateIssueRewakeThrottle({ ...input, hasNewIssueInputSinceLastRun: true,
      recentTerminalRuns: [stale("r2", 3600), stale("r1", 7200)],
    })).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows when there is no run history", () => {
    expect(
      evaluateIssueRewakeThrottle({
        now: NOW,
        recentTerminalRuns: [],
        runIdsWithIssueProgress: new Set(),
        hasNewIssueInputSinceLastRun: false,
      }),
    ).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows below the no-progress threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [runSample({ id: "r1", finishedSecondsAgo: 10 })],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("blocks inside the cooldown once the streak reaches the threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(2);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
      expect(decision.nextAllowedAt.getTime()).toBe(
        NOW.getTime() - 10_000 + ISSUE_REWAKE_BASE_COOLDOWN_MS,
      );
    }
  });

  it("allows again after the cooldown elapses", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 1 }),
        runSample({ id: "r1", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 30 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 2 });
  });

  it("escalates the cooldown as the streak grows", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r4", finishedSecondsAgo: 10 }),
        runSample({ id: "r3", finishedSecondsAgo: 30 }),
        runSample({ id: "r2", finishedSecondsAgo: 60 }),
        runSample({ id: "r1", finishedSecondsAgo: 90 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(4);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 4);
    }
  });

  it("resets at the most recent run with issue-visible progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(["r2"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("blocks repeated swarm and continuation loop wakes during the cooldown", () => {
    const recentTerminalRuns = [
      runSample({ id: "r2", finishedSecondsAgo: 10 }),
      runSample({ id: "r1", finishedSecondsAgo: 40 }),
    ];
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns,
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    expect(isThrottleCandidateIssueRewake({
      reason: "swarm_matched",
      wakeCommentId: null,
      requestedByActorType: "system",
      forceFreshSession: false,
      hasExplicitResume: false,
    })).toBe(true);
    expect(isThrottleCandidateIssueRewake({
      reason: "issue_continuation_needed",
      wakeCommentId: null,
      requestedByActorType: "system",
      forceFreshSession: false,
      hasExplicitResume: false,
    })).toBe(true);
  });

  it("does not delay recovery after a failed run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", status: "failed", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows when new issue input landed after the last run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: true,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("freezes after six empty runs without a time-based escape", () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      runSample({ id: `r${i}`, finishedSecondsAgo: 3600 + i * 30 }));
    const decision = evaluateIssueRewakeThrottle({
      now: NOW, recentTerminalRuns: runs, runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({
      blocked: true, frozen: true, noProgressStreak: 6, frozenAt: runs[0]!.finishedAt,
    });
    expect(evaluateIssueRewakeThrottle({
      now: NOW, recentTerminalRuns: runs, runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: true,
    })).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});

// myrmidon(1.6.6 OPE-12049, TOKEN-BURN H): the swarm_matched / idle_pickup loop
// of 07.11. Every adm run released its task, assigned it to itself and got its
// final text echoed as a comment by the server AFTER the run closed. Those
// writes looked like progress and like new input, so the throttle never
// started. The agent's own writes are not new input for itself, and its own
// bookkeeping is not progress.
describe("agent's own writes in the rewake throttle", () => {
  const AGENT = "agent-adm";
  const OTHER = "agent-other";

  const echoComment = {
    action: "issue.comment_added",
    source: "run_presentation_resolver",
  };
  const release = { action: "issue.released" };
  const reassignToSelf = {
    action: "issue.updated",
    changes: {
      assigneeAgentId: { from: null, to: AGENT },
      responsibleUserId: { from: "user-1", to: null },
    },
  };

  it("does not count release, self re-assignment or the echo of the final text as progress", () => {
    expect(isIssueProgressActivity(release, AGENT)).toBe(false);
    expect(isIssueProgressActivity(reassignToSelf, AGENT)).toBe(false);
    expect(isIssueProgressActivity(echoComment, AGENT)).toBe(false);
  });

  it("still counts a real comment, a status change, a hand-off to another agent and a document as progress", () => {
    expect(isIssueProgressActivity({ action: "issue.comment_added", source: "agent_comment" }, AGENT)).toBe(true);
    expect(isIssueProgressActivity({ action: "issue.comment_added" }, AGENT)).toBe(true);
    expect(isIssueProgressActivity({
      action: "issue.updated", changes: { status: { from: "todo", to: "in_review" } },
    }, AGENT)).toBe(true);
    expect(isIssueProgressActivity({
      action: "issue.updated", changes: { assigneeAgentId: { from: AGENT, to: OTHER } },
    }, AGENT)).toBe(true);
    // re-assignment to itself together with a real status move is a real PATCH
    expect(isIssueProgressActivity({
      action: "issue.updated",
      changes: { assigneeAgentId: { from: null, to: AGENT }, status: { from: "backlog", to: "todo" } },
    }, AGENT)).toBe(true);
    expect(isIssueProgressActivity({ action: "issue.updated" }, AGENT)).toBe(true);
    expect(isIssueProgressActivity({ action: "issue.document_upserted" }, AGENT)).toBe(true);
    // not a progress action at all
    expect(isIssueProgressActivity({ action: "issue.checkout" }, AGENT)).toBe(false);
  });

  it("reads the changes path whether the driver returns an object or its JSON text", () => {
    const changes = { assigneeAgentId: { from: null, to: AGENT } };
    expect(isIssueProgressActivity({ action: "issue.updated", changes: JSON.stringify(changes) }, AGENT)).toBe(false);
    expect(isIssueProgressActivity({ action: "issue.updated", changes: "not json" }, AGENT)).toBe(true);
    // assigned to somebody else is a hand-off, not self-bookkeeping
    expect(isIssueProgressActivity({ action: "issue.updated", changes }, OTHER)).toBe(true);
  });

  it("starts the throttle on runs whose only activity is the agent's own bookkeeping", () => {
    const runs = [0, 1, 2].map((i) => runSample({ id: `r${i}`, finishedSecondsAgo: 60 + i * 120 }));
    const ownRows = [
      ...[release, reassignToSelf, echoComment].map((row) => ({ ...row, runId: "r0" })),
      ...[release, reassignToSelf, echoComment].map((row) => ({ ...row, runId: "r1" })),
      ...[release, reassignToSelf, echoComment].map((row) => ({ ...row, runId: "r2" })),
    ];
    const withProgress = new Set(
      ownRows.filter((row) => isIssueProgressActivity(row, AGENT)).map((row) => row.runId),
    );
    expect(withProgress.size).toBe(0);
    const decision = evaluateIssueRewakeThrottle({
      now: NOW, recentTerminalRuns: runs, runIdsWithIssueProgress: withProgress,
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toMatchObject({ blocked: true, frozen: false, noProgressStreak: 3 });
  });

  it("does not throttle when the latest run really moved the task", () => {
    const runs = [0, 1, 2].map((i) => runSample({ id: `r${i}`, finishedSecondsAgo: 60 + i * 120 }));
    const real = {
      action: "issue.updated", runId: "r0",
      changes: { status: { from: "todo", to: "in_review" } },
    };
    const withProgress = new Set(
      [real, { ...release, runId: "r0" }].filter((row) => isIssueProgressActivity(row, AGENT)).map((row) => row.runId),
    );
    expect(evaluateIssueRewakeThrottle({
      now: NOW, recentTerminalRuns: runs, runIdsWithIssueProgress: withProgress,
      hasNewIssueInputSinceLastRun: false,
    })).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});
