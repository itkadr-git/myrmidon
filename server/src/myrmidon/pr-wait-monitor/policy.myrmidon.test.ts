import { describe, expect, it } from "vitest";
import { isPendingCiForOpenPr } from "../stranded-autopolicy.js";
import {
  PR_WAIT_ACTIVE_CI_STALE_MS,
  PR_WAIT_MAX_INTERVAL_MS,
  PR_WAIT_MIN_INTERVAL_MS,
  PR_WAIT_NO_SIGNAL_WAKE_AFTER_MS,
  ciPendingEvidenceContext,
  evaluatePrWaitMonitor,
  isPrWaitMonitor,
  type PrWaitProductFact,
} from "./policy.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const MIN = 60_000;
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * MIN);
}

function product(overrides: Partial<PrWaitProductFact> & { metadata?: Record<string, unknown> } = {}): PrWaitProductFact {
  const { metadata, ...rest } = overrides;
  return {
    type: "pull_request",
    provider: "github",
    status: "open",
    reviewState: "none",
    url: "https://github.com/company-a/example.com/pull/7",
    updatedAt: minutesAgo(120),
    metadata: { repository: "company-a/example.com", number: 7, headSha: HEAD, ...(metadata ?? {}) },
    ...rest,
  };
}

const CI_MONITOR = { kind: "external_service", serviceName: "CI", notes: "GitHub CI pending monitor", timeoutAt: null };

function evaluate(input: {
  products?: PrWaitProductFact[];
  quietMinutes?: number | null;
  monitor?: typeof CI_MONITOR | Record<string, unknown>;
}) {
  const quiet = input.quietMinutes === undefined ? 10 : input.quietMinutes;
  return evaluatePrWaitMonitor({
    now: NOW,
    monitor: (input.monitor ?? CI_MONITOR) as typeof CI_MONITOR,
    products: input.products ?? [product()],
    agentLastLookAt: quiet === null ? null : minutesAgo(quiet),
  });
}

describe("isPrWaitMonitor", () => {
  it.each([
    [{ serviceName: "CI" }],
    [{ serviceName: "github_actions_ci" }],
    [{ serviceName: "GitHub PR merge sync" }],
    [{ serviceName: "external_service", notes: "Waiting for CI to finish" }],
    [{ serviceName: null, notes: "PR #2487 checks running" }],
  ])("recognizes a pull-request wait: %j", (monitor) => {
    expect(isPrWaitMonitor({ kind: "external_service", ...monitor })).toBe(true);
  });

  it.each([
    [{ serviceName: "vm-core inventory verification" }],
    [{ serviceName: null, notes: "Check deploy" }],
    [{ serviceName: "adm-release-operator", notes: "review the rollout" }],
    [{ kind: "something_else", serviceName: "CI" }],
  ])("ignores other monitors: %j", (monitor) => {
    expect(isPrWaitMonitor(monitor)).toBe(false);
  });
});

describe("evaluatePrWaitMonitor - leaves the monitor alone", () => {
  it("is not applicable to a monitor that does not wait for a pull request", () => {
    expect(evaluate({ monitor: { kind: "external_service", serviceName: "vm-core inventory", notes: null } })).toEqual({
      action: "not_applicable",
      reason: "not_a_pr_wait_monitor",
    });
  });

  it("is not applicable when the task has no live pull request work product", () => {
    expect(evaluate({ products: [] })).toMatchObject({ action: "not_applicable", reason: "no_pull_request" });
    expect(evaluate({ products: [product({ status: "archived" })] })).toMatchObject({ action: "not_applicable", reason: "no_pull_request" });
    expect(evaluate({ products: [product({ provider: "gitlab" })] })).toMatchObject({ action: "not_applicable", reason: "no_pull_request" });
  });

  it("is not applicable without news and without a reference point", () => {
    expect(evaluate({ quietMinutes: null })).toMatchObject({ action: "not_applicable", reason: "no_reference_point" });
  });
});

describe("evaluatePrWaitMonitor - unchanged state re-arms without waking the agent", () => {
  it("defers a pull request with no CI data and grows the interval toward the safety wake", () => {
    const first = evaluate({ quietMinutes: 10 });
    expect(first).toMatchObject({ action: "defer", ciState: "unknown", delayMs: 10 * MIN });
    const second = evaluate({ quietMinutes: 20 });
    // Lands on the 30-minute threshold instead of overshooting it.
    expect(second).toMatchObject({ action: "defer", ciState: "unknown", delayMs: 10 * MIN });
    if (second.action === "defer") expect(second.nextCheckAt.getTime()).toBe(NOW.getTime() + 10 * MIN);
  });

  it("defers a CI that the board knows is running, with a doubling interval capped at 60 minutes", () => {
    const running = { activeCi: { status: "in_progress", headSha: HEAD, observedAt: minutesAgo(5).toISOString() } };
    const delays = [10, 25, 40, 150].map((quiet) => {
      const decision = evaluate({ quietMinutes: quiet, products: [product({ metadata: running })] });
      expect(decision).toMatchObject({ action: "defer", ciState: "pending" });
      return decision.action === "defer" ? decision.delayMs : -1;
    });
    expect(delays).toEqual([10 * MIN, 25 * MIN, 40 * MIN, PR_WAIT_MAX_INTERVAL_MS]);
    expect(PR_WAIT_MIN_INTERVAL_MS).toBe(10 * MIN);
  });

  it("does not trust a running-CI mark for another head or one that was never closed", () => {
    const otherHead = { activeCi: { status: "queued", headSha: OLD_HEAD } };
    expect(evaluate({ products: [product({ metadata: otherHead })] })).toMatchObject({ action: "defer", ciState: "unknown" });
    const abandoned = {
      activeCi: {
        status: "in_progress",
        headSha: HEAD,
        observedAt: new Date(NOW.getTime() - PR_WAIT_ACTIVE_CI_STALE_MS - MIN).toISOString(),
      },
    };
    expect(evaluate({ products: [product({ metadata: abandoned })] })).toMatchObject({ action: "defer", ciState: "unknown" });
  });

  it("ignores facts the agent already knew when it last looked", () => {
    const known = product({
      status: "ready_for_review",
      reviewState: "approved",
      updatedAt: minutesAgo(15),
      metadata: { lastCompletedCi: { conclusion: "success", headSha: HEAD, completedAt: minutesAgo(30).toISOString() } },
    });
    expect(evaluate({ quietMinutes: 10, products: [known] })).toMatchObject({ action: "defer", ciState: "unknown" });
  });

  it("ignores CI that finished on a head the pull request no longer has", () => {
    const outdated = product({
      metadata: { headSha: HEAD, lastCompletedCi: { conclusion: "failure", headSha: OLD_HEAD, completedAt: minutesAgo(2).toISOString() } },
    });
    expect(evaluate({ products: [outdated] })).toMatchObject({ action: "defer" });
  });

  it("does not postpone the hard deadline of the agent", () => {
    const deadline = new Date(NOW.getTime() + 3 * MIN).toISOString();
    const decision = evaluate({ monitor: { ...CI_MONITOR, timeoutAt: deadline } });
    expect(decision).toMatchObject({ action: "defer" });
    if (decision.action === "defer") expect(decision.nextCheckAt.toISOString()).toBe(deadline);
  });
});

describe("evaluatePrWaitMonitor - wakes the agent with the observed change", () => {
  it("wakes when CI completed after the agent last looked and names the conclusion", () => {
    const finished = product({
      metadata: { lastCompletedCi: { conclusion: "failure", headSha: HEAD, runId: "99", completedAt: minutesAgo(3).toISOString() } },
    });
    const decision = evaluate({ quietMinutes: 10, products: [finished] });
    expect(decision.action).toBe("wake");
    if (decision.action !== "wake") return;
    expect(decision.change.kind).toBe("state_changed");
    expect(decision.change.signals).toEqual([
      expect.objectContaining({ kind: "ci_completed", conclusion: "failure", headSha: HEAD, pullRequest: "company-a/example.com#7" }),
    ]);
    expect(decision.change.summary).toContain("CI completed on company-a/example.com#7");
    expect(decision.change.summary).toContain("failure");
    expect(decision.change.quietForMs).toBe(10 * MIN);
  });

  it("wakes when the pull request was merged or closed", () => {
    const merged = evaluate({ products: [product({ status: "merged", updatedAt: minutesAgo(1), metadata: { state: "merged" } })] });
    expect(merged).toMatchObject({ action: "wake", change: { signals: [{ kind: "pr_merged" }] } });
    const closed = evaluate({ products: [product({ status: "closed", updatedAt: minutesAgo(1) })] });
    expect(closed).toMatchObject({ action: "wake", change: { signals: [{ kind: "pr_closed" }] } });
  });

  it("wakes on a merge conflict and on a submitted review, but not on a review request", () => {
    const conflict = evaluate({ products: [product({ updatedAt: minutesAgo(2), metadata: { mergeable: "CONFLICTING" } })] });
    expect(conflict).toMatchObject({ action: "wake", change: { signals: [{ kind: "merge_conflict" }] } });
    const reviewed = evaluate({ products: [product({ reviewState: "approved", updatedAt: minutesAgo(2) })] });
    expect(reviewed).toMatchObject({ action: "wake", change: { signals: [{ kind: "review_submitted", conclusion: "approved" }] } });
    const requested = evaluate({ products: [product({ reviewState: "needs_board_review", updatedAt: minutesAgo(2) })] });
    expect(requested.action).toBe("defer");
  });

  it("lets news outrank a running-CI mark of the same pull request", () => {
    const decision = evaluate({
      products: [product({ updatedAt: minutesAgo(1), metadata: { mergeable: "CONFLICTING", activeCi: { status: "in_progress", headSha: HEAD } } })],
    });
    expect(decision.action).toBe("wake");
  });

  it("wakes on a fact it cannot date against an agent that never ran on the task", () => {
    const finished = product({ metadata: { lastCompletedCi: { conclusion: "success", headSha: HEAD, completedAt: minutesAgo(50).toISOString() } } });
    expect(evaluate({ quietMinutes: null, products: [finished] }).action).toBe("wake");
  });

  it("wakes once with a no-signal note when the board has seen nothing for the safety period", () => {
    const decision = evaluate({ quietMinutes: PR_WAIT_NO_SIGNAL_WAKE_AFTER_MS / MIN });
    expect(decision.action).toBe("wake");
    if (decision.action !== "wake") return;
    expect(decision.change.kind).toBe("no_signal");
    expect(decision.change.signals).toEqual([]);
    expect(decision.change.summary).toContain("30 min");
  });

  it("never wakes for the safety period while the board knows the CI is running", () => {
    const running = { activeCi: { status: "in_progress", headSha: HEAD, observedAt: minutesAgo(2).toISOString() } };
    expect(evaluate({ quietMinutes: 45, products: [product({ metadata: running })] }).action).toBe("defer");
  });
});

describe("ciPendingEvidenceContext", () => {
  const monitorRunContext = {
    wakeReason: "issue_monitor_due",
    serviceName: "CI",
    monitorNotes: "GitHub CI pending monitor",
  };
  const openPrWithoutHead = { metadata: { repo: "company-a/example.com", number: 7, state: "open" }, updatedAt: null };

  it("drops the context of a run a monitor woke and keeps every other context", () => {
    expect(ciPendingEvidenceContext(monitorRunContext)).toBeNull();
    const assignmentRun = { wakeReason: "issue_assigned", monitorNotes: "GitHub CI pending monitor" };
    expect(ciPendingEvidenceContext(assignmentRun)).toBe(assignmentRun);
    expect(ciPendingEvidenceContext(null)).toBeNull();
  });

  it("stops the monitor's own note from re-arming the monitor after a monitor run", () => {
    // The defect: the note of the monitor is read as proof that CI is pending, again and again.
    expect(isPendingCiForOpenPr({ openPr: openPrWithoutHead, lastComment: null, contextSnapshot: monitorRunContext })).toBe(true);
    expect(
      isPendingCiForOpenPr({
        openPr: openPrWithoutHead,
        lastComment: null,
        contextSnapshot: ciPendingEvidenceContext(monitorRunContext),
      }),
    ).toBe(false);
  });

  it("still re-arms when the agent itself wrote that CI is running", () => {
    expect(
      isPendingCiForOpenPr({
        openPr: openPrWithoutHead,
        lastComment: { body: "CI is still running, waiting for checks", createdAt: NOW },
        contextSnapshot: ciPendingEvidenceContext(monitorRunContext),
      }),
    ).toBe(true);
  });
});
