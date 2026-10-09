// myrmidon(1.6.5 RUN-PRIORITY-PICK): the per-agent pass has to start the
// agent's most important ready task, not the best of its standing runs.
//
// The acceptance test of the ticket lives here: an agent holding one low run
// driven by an event, with its critical task assigned, ready and without a run,
// starts the critical task next — and a run waiting past the starvation limit
// does not overtake a more important task, whatever its wait.
//
// Everything below the orchestrator is pure or injected, so the whole decision
// is exercised without a database: the ready task, the wake and the hold are
// fakes, and the weight assertions use the very `runPriorityWeight` the sweeps
// use.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS,
  runPriorityWeight,
  type RunPrioritySettings,
} from "@paperclipai/shared";
import {
  RUN_PRIORITY_PICK_WAIT_REASON,
  decideRunPriorityPick,
  runPriorityPickForAgent,
  runPriorityPickImportance,
  shouldSkipPickForOperatorCancellation,
  type RunPriorityPickCandidate,
  type RunPriorityPickOutcome,
  type RunPriorityPickReadyTask,
} from "./pick.js";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

/** The defaults the sweeps run with, spelled out so the arithmetic is readable. */
function settings(overrides: Partial<RunPrioritySettings> = {}): RunPrioritySettings {
  return {
    enabled: true,
    roleWeights: { ...DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS },
    defaultRoleWeight: 30,
    issuePriorityWeights: { critical: 100, high: 80, medium: 60, low: 40, none: 20 },
    currentRelease: null,
    releaseBonus: 20,
    agingStepMinutes: 10,
    agingStepWeight: 5,
    agingMaxBonus: 50,
    starvationLimitMinutes: 90,
    starvationTopWeight: 10_000,
    pheromoneWeight: 1,
    ...overrides,
  };
}

/** One standing run of the agent: the low event run of the ticket's scenario. */
function candidate(
  runId: string,
  issueId: string | null,
  issuePriority: string | null,
  extraWeight = 0,
): RunPriorityPickCandidate {
  return { runId, issueId, issuePriority, extraWeight };
}

/** The weight the sweeps compute for a run — the pick must agree with it. */
function weightOf(
  issuePriority: string | null,
  waitedMin: number,
  config: RunPrioritySettings = settings(),
  releaseMatched = false,
): number {
  return runPriorityWeight(
    {
      role: "engineer",
      hasIssue: issuePriority !== null,
      issuePriority,
      releaseMatched,
      createdAtMs: NOW - waitedMin * MIN,
    },
    config,
    NOW,
  );
}

describe("decideRunPriorityPick", () => {
  const base = settings();

  it("starts the critical ready task of an agent holding one low event run", () => {
    // The ticket's scenario, verbatim: the agent has ONE low run in the queue
    // (the event run that is holding it) and its critical task is assigned,
    // ready, without a run. The low run is the candidate; the critical task
    // must start first and the candidate stays in the queue.
    const low = candidate("low-run", "issue-low", "low");
    const decision = decideRunPriorityPick({
      settings: base,
      candidates: [low],
      readyTask: { issueId: "issue-critical", issuePriority: "critical" },
    });

    expect(decision.pickIssueId).toBe("issue-critical");
    expect(decision.heldRunIds).toEqual(["low-run"]);
    expect(decision.reason).toBe("picked");
  });

  it("holds every standing run of the agent when it starts a more important task", () => {
    const decision = decideRunPriorityPick({
      settings: base,
      candidates: [
        candidate("run-low", "issue-low", "low"),
        candidate("run-high", "issue-high", "high"),
        candidate("run-medium", "issue-medium", "medium"),
      ],
      readyTask: { issueId: "issue-critical", issuePriority: "critical" },
    });
    expect(decision.pickIssueId).toBe("issue-critical");
    // Every standing run is below the critical task, so every one of them waits.
    // A run of an equal step cannot meet a pick at all: the pick needs a task
    // strictly more important than the best standing run, so "equal is not
    // held" stays a guard of the rule, never a case the sweep can enter.
    expect(decision.heldRunIds).toEqual(["run-low", "run-high", "run-medium"]);
  });

  it("does not reorder for a task of the same or lower importance", () => {
    const same = decideRunPriorityPick({
      settings: base,
      candidates: [candidate("run-medium", "issue-a", "medium")],
      readyTask: { issueId: "issue-b", issuePriority: "medium" },
    });
    expect(same.pickIssueId).toBeNull();
    expect(same.reason).toBe("not_more_important");

    const lower = decideRunPriorityPick({
      settings: base,
      candidates: [candidate("run-critical", "issue-a", "critical")],
      readyTask: { issueId: "issue-b", issuePriority: "low" },
    });
    expect(lower.pickIssueId).toBeNull();
    expect(lower.reason).toBe("not_more_important");
  });

  it("compares the pheromone strength with the same term the weight carries", () => {
    // A ready task one step below the run but strongly scented is more
    // important: the pick reads the composed term (OPE-6614 mixes its strength
    // into the weight), not the bare priority.
    const decision = decideRunPriorityPick({
      settings: base,
      candidates: [candidate("run-high", "issue-high", "high")],
      readyTask: { issueId: "issue-scented", issuePriority: "medium", extraWeight: 30 },
    });
    expect(decision.pickIssueId).toBe("issue-scented");
    expect(decision.readyImportance).toBe(90);
    expect(decision.bestImportance).toBe(80);
  });

  it("reports nothing to do without candidates, without a ready task, or when off", () => {
    expect(
      decideRunPriorityPick({
        settings: base,
        candidates: [],
        readyTask: { issueId: "issue-critical", issuePriority: "critical" },
      }).reason,
    ).toBe("no_candidates");
    expect(
      decideRunPriorityPick({ settings: base, candidates: [candidate("r", null, "low")], readyTask: null })
        .reason,
    ).toBe("no_ready_task");
    expect(
      decideRunPriorityPick({
        settings: settings({ enabled: false }),
        candidates: [candidate("r", "issue-low", "low")],
        readyTask: { issueId: "issue-critical", issuePriority: "critical" },
      }).reason,
    ).toBe("disabled");
  });

  it("ignores the candidate the ready task itself owns", () => {
    const decision = decideRunPriorityPick({
      settings: base,
      candidates: [candidate("own-run", "issue-critical", "critical")],
      readyTask: { issueId: "issue-critical", issuePriority: "critical" },
    });
    expect(decision.pickIssueId).toBeNull();
    expect(decision.reason).toBe("same_task");
  });
});

describe("the starvation limit is not a licence to overtake a more important task", () => {
  const base = settings();

  it("does not let a low run waiting past 90 minutes overtake a fresh critical task", () => {
    // The acceptance test of the ticket, on the weights themselves: same role,
    // so the starvation escape is the only thing that could decide it.
    const starvedLow = weightOf("low", 91);
    const freshCritical = weightOf("critical", 0);
    expect(starvedLow).toBeLessThan(freshCritical);

    // … and it stays that way however long the low run waits: the escape lift
    // is bounded by the distance to the next step, so the low run ends at the
    // top of its own step plus the (unchanged) aging budget.
    expect(weightOf("low", 600)).toBeLessThan(freshCritical);
    expect(weightOf("none", 601)).toBeLessThan(freshCritical);

    // The pick reaches the same verdict: the starved low run is the candidate
    // the critical task overtakes.
    const decision = decideRunPriorityPick({
      settings: base,
      candidates: [candidate("starved-low-run", "issue-low", "low")],
      readyTask: { issueId: "issue-critical", issuePriority: "critical" },
    });
    expect(decision.pickIssueId).toBe("issue-critical");
  });

  it("keeps the escape inside the run's own importance step", () => {
    // With aging off the escape alone decides: a medium run past the limit is
    // lifted to the top of its own step and may not reach the high step of the
    // same role.
    const noAging = settings({ agingStepMinutes: 0, agingStepWeight: 0, agingMaxBonus: 0 });
    expect(weightOf("medium", 600, noAging)).toBeLessThan(weightOf("high", 0, noAging));
    // and it is still above its own fresh self: the escape keeps meaning
    // something for the runs it protects
    expect(weightOf("medium", 91, noAging)).toBeGreaterThan(weightOf("medium", 0, noAging));
    expect(weightOf("medium", 600, noAging)).toBe(weightOf("medium", 601, noAging));
    // Aging is its own dimension and this change leaves it alone. Its budget
    // (50) is wider than one step gap (20), so a long wait can still cross a
    // step the way it always could — the escape no longer adds to that.
    expect(weightOf("medium", 600)).toBeGreaterThan(weightOf("high", 0));
  });

  it("still lifts a starved run of the heaviest step above everything", () => {
    // Nothing is more important than a critical task, so its run keeps the
    // escape lane: a review/release run of a critical issue is no reason to
    // hold it.
    const starvedCritical = runPriorityWeight(
      { role: "engineer", hasIssue: true, issuePriority: "critical", releaseMatched: false, createdAtMs: NOW - 91 * MIN },
      base,
      NOW,
    );
    const reviewCriticalRelease = runPriorityWeight(
      { role: "review", hasIssue: true, issuePriority: "critical", releaseMatched: true, createdAtMs: NOW },
      base,
      NOW,
    );
    expect(starvedCritical).toBeGreaterThan(reviewCriticalRelease);
  });
});

describe("runPriorityPickForAgent", () => {
  const base = settings();

  function harness(overrides: {
    settings?: RunPrioritySettings;
    candidates?: RunPriorityPickCandidate[];
    readyTask?: { issueId: string; issuePriority: string | null } | null;
    woken?: boolean;
    cancellation?: { issueId: string; cancelledAtMs: number; newEventAtMs: number | null } | null;
  } = {}) {
    const wake = vi.fn(async (_task: RunPriorityPickReadyTask) => overrides.woken ?? true);
    const holdRuns = vi.fn(async () => {});
    const log = vi.fn();
    const run = () =>
      runPriorityPickForAgent({
        settings: overrides.settings ?? base,
        candidates: overrides.candidates ?? [candidate("low-run", "issue-low", "low")],
        findReadyTask: async () => overrides.readyTask ?? { issueId: "issue-critical", issuePriority: "critical" },
        wake,
        holdRuns,
        operatorCancellation: async () => overrides.cancellation ?? null,
        nowMs: NOW,
        log,
      });
    return { run, wake, holdRuns, log };
  }

  it("wakes the critical task and holds the low run with the wait reason", async () => {
    const { run, wake, holdRuns } = harness();
    const outcome: RunPriorityPickOutcome = await run();

    expect(outcome.picked).toBe(true);
    expect(outcome.issueId).toBe("issue-critical");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toMatchObject({ issueId: "issue-critical" });
    expect(holdRuns).toHaveBeenCalledWith(["low-run"], RUN_PRIORITY_PICK_WAIT_REASON, {
      pickedIssueId: "issue-critical",
      readyImportance: 100,
      bestImportance: 40,
    });
  });

  it("leaves the queue alone when the wake is suppressed", async () => {
    // A paused agent, an exhausted wake budget, a coalesced duplicate or the
    // behaviour switched off: nothing was woken, so nothing is held — the pass
    // starts the standing run exactly as it would without the pick.
    const { run, holdRuns } = harness({ woken: false });
    const outcome = await run();
    expect(outcome.picked).toBe(false);
    expect(outcome.reason).toBe("wake_suppressed");
    expect(holdRuns).not.toHaveBeenCalled();
  });

  it("does not put a task the operator just cancelled straight back", async () => {
    // Requirement 3: the Stop that cancelled the run is durable intent until
    // the task gets new information.
    const cancelled = harness({
      cancellation: { issueId: "issue-critical", cancelledAtMs: NOW - 5 * MIN, newEventAtMs: null },
    });
    const held = await cancelled.run();
    expect(held.picked).toBe(false);
    expect(held.reason).toBe("operator_cancelled");
    expect(cancelled.wake).not.toHaveBeenCalled();
    expect(cancelled.holdRuns).not.toHaveBeenCalled();

    // a newer event on the task makes it fair game again
    const revived = harness({
      cancellation: { issueId: "issue-critical", cancelledAtMs: NOW - 5 * MIN, newEventAtMs: NOW - MIN },
    });
    expect((await revived.run()).picked).toBe(true);
  });

  it("never throws and never spends the ready-task read when nothing is queued", async () => {
    const findReadyTask = vi.fn(async () => null);
    const outcome = await runPriorityPickForAgent({
      settings: base,
      candidates: [],
      findReadyTask,
      wake: async () => true,
      holdRuns: async () => {},
      nowMs: NOW,
    });
    expect(outcome.reason).toBe("no_candidates");
    expect(findReadyTask).not.toHaveBeenCalled();
  });

  it("falls back to the pass's own order when the settings are off", async () => {
    const { run, wake } = harness({ settings: settings({ enabled: false }) });
    const outcome = await run();
    expect(outcome.reason).toBe("disabled");
    expect(wake).not.toHaveBeenCalled();
  });

  it("keeps a task of equal importance in the queue (no reorder, no wake)", async () => {
    const { run, wake, holdRuns } = harness({
      candidates: [candidate("medium-run", "issue-a", "medium")],
      readyTask: { issueId: "issue-b", issuePriority: "medium" },
    });
    const outcome = await run();
    expect(outcome.reason).toBe("not_more_important");
    expect(wake).not.toHaveBeenCalled();
    expect(holdRuns).not.toHaveBeenCalled();
  });
});

describe("shouldSkipPickForOperatorCancellation", () => {
  it("holds the task back until a newer event arrives", () => {
    expect(shouldSkipPickForOperatorCancellation(null)).toBe(false);
    expect(
      shouldSkipPickForOperatorCancellation({ issueId: "i", cancelledAtMs: 1_000, newEventAtMs: null }),
    ).toBe(true);
    expect(
      shouldSkipPickForOperatorCancellation({ issueId: "i", cancelledAtMs: 1_000, newEventAtMs: 1_500 }),
    ).toBe(false);
    // a wake recorded with the same (coarser) timestamp is not new information
    expect(
      shouldSkipPickForOperatorCancellation({ issueId: "i", cancelledAtMs: 1_000, newEventAtMs: 1_000 }),
    ).toBe(true);
  });
});

describe("runPriorityPickImportance", () => {
  it("reads an unknown priority as the none step and adds the strength term", () => {
    const base = settings();
    expect(runPriorityPickImportance("critical", base)).toBe(100);
    expect(runPriorityPickImportance(null, base)).toBe(20);
    expect(runPriorityPickImportance("something-new", base)).toBe(20);
    expect(runPriorityPickImportance("low", base, 7)).toBe(47);
    expect(runPriorityPickImportance("low", base, Number.NaN)).toBe(40);
  });
});