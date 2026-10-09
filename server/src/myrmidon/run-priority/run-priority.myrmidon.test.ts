// myrmidon(1.6.5 RUN-PRIORITY A): the queue scoring core.
//
// The weight function and the comparator are pure, so the order the sweeps
// take from them — review/release over an older engineer run, the release
// bonus, aging, the starvation escape, and a settings change applying without
// a restart — is exercised here without a database. The heartbeat file under
// test consumes exactly these functions.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS,
  DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS,
  MAX_PHEROMONE_STRENGTH,
  RUN_PRIORITY_PHEROMONE_MAX_POINTS,
  normalizeRunPrioritySettings,
  readRunPriorityFromEnv,
  releaseTagMatches,
  runPriorityWeight,
  type RunPrioritySettings,
} from "@paperclipai/shared";
import {
  compareRunsByPriority,
  rankQueuedRuns,
  runMatchesCurrentRelease,
  sortByRunPriority,
  type PriorityScoredRun,
} from "./scoring.js";
import {
  applyRunPrioritySettings,
  currentRunPrioritySettings,
  resetRunPriorityForTests,
  resolveRunPriority,
} from "./state.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const ENV_FREE: Record<string, string | undefined> = Object.fromEntries(
  Object.values({
    enabled: "MYRMIDON_RUN_PRIORITY_ENABLED",
    roleWeights: "MYRMIDON_RUN_PRIORITY_ROLE_WEIGHTS",
    defaultRoleWeight: "MYRMIDON_RUN_PRIORITY_DEFAULT_ROLE_WEIGHT",
    issuePriorityWeights: "MYRMIDON_RUN_PRIORITY_ISSUE_WEIGHTS",
    currentRelease: "MYRMIDON_CURRENT_RELEASE",
    releaseBonus: "MYRMIDON_RUN_RELEASE_BONUS",
    agingStepMinutes: "MYRMIDON_RUN_AGING_STEP_MIN",
    agingStepWeight: "MYRMIDON_RUN_AGING_STEP_WEIGHT",
    agingMaxBonus: "MYRMIDON_RUN_AGING_MAX_BONUS",
    starvationLimitMinutes: "MYRMIDON_RUN_STARVATION_LIMIT_MIN",
    starvationTopWeight: "MYRMIDON_RUN_STARVATION_TOP_WEIGHT",
  }).map((key) => [key, undefined]),
);

function settings(overrides: Partial<RunPrioritySettings> = {}): RunPrioritySettings {
  return { ...readRunPriorityFromEnv(ENV_FREE), ...overrides };
}

function scored(
  id: string,
  role: string | null,
  issuePriority: string | null,
  waitedMin: number,
  releaseMatched = false,
): PriorityScoredRun {
  return {
    id,
    role,
    hasIssue: issuePriority !== null,
    issuePriority,
    releaseMatched,
    createdAtMs: NOW - waitedMin * MIN,
  };
}

/**
 * The width of one role band under `settings` (the contract: wider than the
 * heaviest issue weight, the release bonus and the whole aging budget, the
 * starvation escape included) — the scoring mirrors it.
 */
function bandOf(settings: RunPrioritySettings): number {
  return (
    Math.max(0, ...Object.values(settings.issuePriorityWeights)) +
    settings.releaseBonus +
    Math.max(settings.agingMaxBonus, settings.starvationTopWeight) +
    // 1.6.5 (F-27 review fix): the pheromone term is a bounded part of the band.
    settings.pheromoneWeight * RUN_PRIORITY_PHEROMONE_MAX_POINTS +
    1
  );
}

/** One whole lane above the heaviest role: what a current-release run is lifted by. */
function laneOf(settings: RunPrioritySettings): number {
  return (
    (Math.max(0, ...Object.values(settings.roleWeights), settings.defaultRoleWeight) + 1) *
    bandOf(settings)
  );
}

describe("runPriorityWeight", () => {
  const base = settings();
  const band = bandOf(base);

  it("bands the weight by the role and only orders the issues inside the band", () => {
    const engineer = runPriorityWeight(
      { role: "engineer", hasIssue: true, issuePriority: "medium", releaseMatched: false, createdAtMs: NOW },
      base,
      NOW,
    );
    const reviewer = runPriorityWeight(
      { role: "review", hasIssue: true, issuePriority: "medium", releaseMatched: false, createdAtMs: NOW },
      base,
      NOW,
    );
    const criticalEngineer = runPriorityWeight(
      { role: "engineer", hasIssue: true, issuePriority: "critical", releaseMatched: false, createdAtMs: NOW },
      base,
      NOW,
    );
    // weight = role x band + issue: the issue priority refines the role's band
    expect(engineer).toBe(
      DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.engineer * band +
        DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS.medium,
    );
    expect(reviewer).toBe(
      DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.review * band +
        DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS.medium,
    );
    expect(reviewer).toBeGreaterThan(engineer);
    // the critical issue stays inside the engineer's band: unlike max(role,
    // issue) it can neither tie nor beat the review band (review #829's defect)
    expect(criticalEngineer).toBe(
      DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.engineer * band +
        DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS.critical,
    );
    expect(criticalEngineer).toBeLessThan(reviewer);
  });

  it("gives a run without an issue the plain band of its role", () => {
    const w = runPriorityWeight(
      { role: "engineer", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW },
      base,
      NOW,
    );
    expect(w).toBe(DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.engineer * band);
  });

  it("lifts a current-release run one whole lane above the heaviest role", () => {
    const withRelease = runPriorityWeight(
      { role: "engineer", hasIssue: true, issuePriority: "high", releaseMatched: true, createdAtMs: NOW },
      base,
      NOW,
    );
    const without = runPriorityWeight(
      { role: "engineer", hasIssue: true, issuePriority: "high", releaseMatched: false, createdAtMs: NOW },
      base,
      NOW,
    );
    expect(withRelease - without).toBe(base.releaseBonus + laneOf(base));
    // the lane starts current-release work before the heaviest role with its
    // heaviest issue, however long that one has waited inside its band
    const heaviestOther = runPriorityWeight(
      { role: "review", hasIssue: true, issuePriority: "critical", releaseMatched: false, createdAtMs: NOW - 89 * MIN },
      base,
      NOW,
    );
    expect(withRelease).toBeGreaterThan(heaviestOther);
  });

  it("grows the weight with the wait, capped at the aging bonus", () => {
    const input = (waitedMin: number) => ({
      role: "engineer",
      hasIssue: true,
      issuePriority: "medium",
      releaseMatched: false,
      createdAtMs: NOW - waitedMin * MIN,
    });
    const fresh = runPriorityWeight(input(0), base, NOW);
    const waited = runPriorityWeight(input(30), base, NOW); // 3 steps of 5
    expect(waited - fresh).toBe(3 * base.agingStepWeight);
    expect(runPriorityWeight(input(89), base, NOW) - fresh).toBe(8 * base.agingStepWeight);
    // the cap itself is only reachable with the starvation escape off: a
    // 100-minute wait would otherwise short-circuit to the escape lane
    const noEscape = { ...base, starvationLimitMinutes: 0 };
    expect(runPriorityWeight(input(120), noEscape, NOW) - runPriorityWeight(input(0), noEscape, NOW)).toBe(
      noEscape.agingMaxBonus,
    );
    // aging never leaves the band: 89 minutes of waiting push the engineer's
    // critical issue to the top of its band, not above the review band
    expect(runPriorityWeight(input(89), base, NOW)).toBeLessThan(
      runPriorityWeight(
        { role: "review", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW },
        base,
        NOW,
      ),
    );
    // past the 90-minute limit the run takes the escape lane — a step, not a
    // slope, and above every role, the current-release lane included
    const escaped = runPriorityWeight(input(100), base, NOW);
    expect(runPriorityWeight(input(90), base, NOW)).toBe(escaped);
    expect(runPriorityWeight(input(240), base, NOW)).toBe(escaped);
    expect(escaped).toBeGreaterThan(
      runPriorityWeight(
        { role: "review", hasIssue: true, issuePriority: "critical", releaseMatched: true, createdAtMs: NOW },
        base,
        NOW,
      ),
    );
  });

  it("grants the escape lane past the starvation limit, and nothing when the limit is off", () => {
    const starved = runPriorityWeight(
      { role: "general", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW - 91 * MIN },
      base,
      NOW,
    );
    expect(starved).toBeGreaterThan(
      runPriorityWeight(
        { role: "review", hasIssue: true, issuePriority: "critical", releaseMatched: true, createdAtMs: NOW },
        base,
        NOW,
      ),
    );
    const noLimit = settings({ starvationLimitMinutes: 0 });
    const stillAging = runPriorityWeight(
      { role: "general", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW - 91 * MIN },
      noLimit,
      NOW,
    );
    // without the escape the same wait stays inside the general band
    expect(stillAging).toBeLessThan(
      runPriorityWeight(
        { role: "review", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW },
        noLimit,
        NOW,
      ),
    );
  });

  it("scores every run zero while the feature is switched off", () => {
    const off = settings({ enabled: false });
    const weight = runPriorityWeight(
      { role: "review", hasIssue: true, issuePriority: "critical", releaseMatched: true, createdAtMs: NOW - 100 * MIN },
      off,
      NOW,
    );
    expect(weight).toBe(0);
  });
});

describe("compareRunsByPriority", () => {
  const base = settings({ currentRelease: "1.6.5-rc.6" });

  it("starts the review run before the older engineer run and keeps createdAt as the tie-break", () => {
    const reviewer = scored("rev", "review", "medium", 2);
    const engineer = scored("eng", "engineer", "medium", 500);
    // the 500-minute wait takes the engineer run into the starvation escape
    // lane, so compare at a pre-escape wait where the role band decides alone
    const freshEngineer = scored("eng", "engineer", "medium", 5);
    expect(compareRunsByPriority(reviewer, freshEngineer, base, NOW)).toBeLessThan(0);
    expect(compareRunsByPriority(reviewer, engineer, base, NOW)).toBeGreaterThan(0);
    // equal weights (the same band, issue and aging step) fall back to FIFO
    const older = scored("a", "engineer", "medium", 5);
    const newer = scored("b", "engineer", "medium", 2);
    expect(compareRunsByPriority(older, newer, base, NOW)).toBeLessThan(0);
    expect(sortByRunPriority([newer, older], base, NOW).map((r) => r.id)).toEqual(["a", "b"]);
    // identical scores order by id for determinism
    const twin1 = scored("t1", "engineer", "medium", 5);
    const twin2 = scored("t2", "engineer", "medium", 5);
    expect(sortByRunPriority([twin2, twin1], base, NOW).map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("keeps the issue priority order inside one strong role (lead): high before low, then FIFO", () => {
    // lead(80) band: high(80), medium(60), low(40) and none(20) order the band
    // themselves; the per-agent tie-break only separates runs of the same weight
    const rank = (priority: string | null) =>
      ["critical", "high", "medium", "low"].indexOf(priority ?? "") === -1
        ? 4
        : ["critical", "high", "medium", "low"].indexOf(priority ?? "");
    const tieBreak = (l: PriorityScoredRun, r: PriorityScoredRun) =>
      rank(l.issuePriority) - rank(r.issuePriority);
    const lowOld = scored("low-old", "lead", "low", 9);
    const highNew = scored("high-new", "lead", "high", 2);
    const noneOld = scored("none-old", "lead", "none", 8);
    const mediumNew = scored("medium-new", "lead", "medium", 1);
    const order = [lowOld, highNew, noneOld, mediumNew]
      .sort((a, b) => compareRunsByPriority(a, b, base, NOW, tieBreak))
      .map((run) => run.id);
    expect(order).toEqual(["high-new", "medium-new", "low-old", "none-old"]);
    // same priority: createdAt FIFO
    const a = scored("a", "lead", "high", 5);
    const b = scored("b", "lead", "high", 3);
    expect(compareRunsByPriority(a, b, base, NOW, tieBreak)).toBeLessThan(0);
  });

  it("lifts the current-release run above its plain role weight", () => {
    const plainEngineer = scored("e1", "engineer", "medium", 0);
    const releaseEngineer = scored("e2", "engineer", "medium", 0, true);
    expect(compareRunsByPriority(releaseEngineer, plainEngineer, base, NOW)).toBeLessThan(0);
  });

  it("pulls a starving general run to the front of a fresh review queue", () => {
    const reviewer = scored("rev", "review", "critical", 3);
    const starving = scored("gen", "general", "low", 91);
    expect(compareRunsByPriority(starving, reviewer, base, NOW)).toBeLessThan(0);
  });

  it("degenerates to createdAt FIFO when the feature is off", () => {
    const off = settings({ enabled: false });
    const reviewer = scored("rev", "review", "critical", 2, true);
    const engineer = scored("eng", "engineer", "low", 500);
    expect(compareRunsByPriority(reviewer, engineer, off, NOW)).toBeGreaterThan(0);
  });
});

// The defect review #829 blocked on: with max(role weight, issue weight) a
// critical issue lifted an engineer run over the review/release role, and aging
// could do the same. The role — and the current release — must decide the
// order, whatever the issue priority or the waiting time is.
describe("role protection across the queue", () => {
  const base = settings({ currentRelease: "1.6.5-rc.7" });

  it("starts review and release work before a critical issue of any other role", () => {
    const criticalEngineer = scored("eng", "engineer", "critical", 0);
    const criticalLead = scored("lead", "lead", "critical", 0);
    const reviewRun = scored("rev", "review", "low", 0);
    const releaseRoleRun = scored("rel", "release", "none", 0);
    expect(compareRunsByPriority(reviewRun, criticalEngineer, base, NOW)).toBeLessThan(0);
    expect(compareRunsByPriority(reviewRun, criticalLead, base, NOW)).toBeLessThan(0);
    expect(compareRunsByPriority(releaseRoleRun, criticalEngineer, base, NOW)).toBeLessThan(0);
    // ... and the whole queue comes out that way, not just the pair
    const order = sortByRunPriority(
      [criticalEngineer, reviewRun, criticalLead, releaseRoleRun],
      base,
      NOW,
    ).map((run) => run.id);
    expect(order.slice(0, 2).sort()).toEqual(["rel", "rev"]);
  });

  it("starts current-release work before a critical issue of any role", () => {
    const tagged = scored("tag", "engineer", "low", 0, true);
    expect(compareRunsByPriority(tagged, scored("eng", "engineer", "critical", 0), base, NOW)).toBeLessThan(0);
    expect(compareRunsByPriority(tagged, scored("rev", "review", "critical", 0), base, NOW)).toBeLessThan(0);
    expect(compareRunsByPriority(tagged, scored("lead", "lead", "critical", 0), base, NOW)).toBeLessThan(0);
  });

  it("keeps aging from lifting a run over a heavier role", () => {
    // the longest wait that stays below the starvation limit, with the aging
    // budget spent to the last step before the escape
    const agedEngineer = scored("eng-aged", "engineer", "critical", 89);
    expect(compareRunsByPriority(scored("rev", "review", "low", 0), agedEngineer, base, NOW)).toBeLessThan(0);
    expect(compareRunsByPriority(scored("tag", "engineer", "low", 0, true), agedEngineer, base, NOW)).toBeLessThan(0);
    // a heavier role's own wait keeps it in front of the aged engineer run too
    expect(compareRunsByPriority(scored("rev-aged", "review", "low", 89), agedEngineer, base, NOW)).toBeLessThan(0);
  });

  it("still lets the starvation escape take the front, and the longer wait win inside one role", () => {
    const starved = scored("starved", "engineer", "none", 91);
    expect(compareRunsByPriority(starved, scored("rev", "review", "critical", 0, true), base, NOW)).toBeLessThan(0);
    // inside one role the longer wait goes first (the aging bonus ordering)
    expect(
      compareRunsByPriority(scored("old", "engineer", "medium", 70), scored("new", "engineer", "high", 5), base, NOW),
    ).toBeLessThan(0);
  });
});

describe("rankQueuedRuns", () => {
  const base = settings({ currentRelease: "1.6.5-rc.7" });

  it("numbers the waiting queue from the next run to start", () => {
    const reviewRun = scored("rev", "review", "low", 0);
    const tagged = scored("tag", "engineer", "medium", 0, true);
    const critical = scored("eng-critical", "engineer", "critical", 0);
    const aged = scored("eng-aged", "engineer", "low", 80);
    const ranked = rankQueuedRuns([critical, aged, reviewRun, tagged], base, NOW);
    // the rank the run card shows next to the wait reason: current-release
    // work, then the review band, then the engineer's critical issue, then the
    // aged engineer run
    expect([...ranked.keys()]).toEqual(["tag", "rev", "eng-critical", "eng-aged"]);
    expect(ranked.get("tag")).toBe(1);
    expect(ranked.get("eng-aged")).toBe(4);
    expect(ranked.size).toBe(4);
  });
});

describe("release markers", () => {
  it("matches the tag against labels and branch names both ways, min length guarded", () => {
    expect(releaseTagMatches("1.6.5-rc.6", "1.6.5-rc.6")).toBe(true);
    expect(releaseTagMatches("rc.6", "1.6.5-rc.6")).toBe(true);
    expect(releaseTagMatches("1.6.5-rc.6", "myr/1.6.5-rc.6-hotfix")).toBe(true);
    expect(releaseTagMatches("1.6.5-rc.6", "RC.7")).toBe(false);
    expect(releaseTagMatches("rc", "rc.6")).toBe(false); // below the 3-char guard
    expect(releaseTagMatches(null, "1.6.5-rc.6")).toBe(false);
    expect(runMatchesCurrentRelease(null, ["1.6.5-rc.6"])).toBe(false);
    expect(runMatchesCurrentRelease("1.6.5-rc.6", [null, undefined, "rc.9", "1.6.5-rc.6"])).toBe(true);
  });
});

describe("live settings without a restart (state)", () => {
  it("follows the in-force row so the next sweep pass picks up a changed weight", () => {
    resetRunPriorityForTests();
    const before = currentRunPrioritySettings(ENV_FREE);
    expect(before.roleWeights.review).toBe(DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.review);

    // the PATCH path of the service pushes the merged settings in force;
    // the sweeps re-read them on every pass — no process restart anywhere.
    const next = normalizeRunPrioritySettings(
      { roleWeights: { review: 10 } },
      resolveRunPriority(undefined, ENV_FREE).settings,
    );
    applyRunPrioritySettings(next);
    const during = currentRunPrioritySettings(ENV_FREE);
    expect(during.roleWeights.review).toBe(10);

    // a heavier engineer now outranks the de-weighted reviewer
    const reviewer = scored("rev", "review", "medium", 0);
    const engineer = scored("eng", "engineer", "high", 0);
    expect(compareRunsByPriority(reviewer, engineer, during, NOW)).toBeGreaterThan(0);

    resetRunPriorityForTests();
    expect(currentRunPrioritySettings(ENV_FREE).roleWeights.review).toBe(
      DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.review,
    );
  });

  it("resolves precedence stored > env > default, per key", () => {
    const env = { ...ENV_FREE, MYRMIDON_RUN_RELEASE_BONUS: "7", MYRMIDON_CURRENT_RELEASE: "1.6.5-rc.6" };
    const view = resolveRunPriority({ roleWeights: { review: 42 } }, env);
    expect(view.source).toBe("settings");
    expect(view.settings.roleWeights.review).toBe(42);
    // untouched keys still come from the environment
    expect(view.settings.releaseBonus).toBe(7);
    expect(view.settings.currentRelease).toBe("1.6.5-rc.6");
    // an empty row means "env"
    expect(resolveRunPriority({}, env).source).toBe("env");
  });

  it("the pheromone term moves a run inside its role band (1.6.5 F-27 rework)", () => {
    const prio = settings();
    const base = {
      role: "engineer",
      hasIssue: true,
      issuePriority: "medium",
      releaseMatched: false,
      createdAtMs: NOW,
    };
    const unscented = runPriorityWeight({ ...base, effectivePheromone: 0 }, prio, NOW);
    const scented = runPriorityWeight({ ...base, effectivePheromone: 40 }, prio, NOW);
    // Default pheromoneWeight = 1: every effective-pheromone point is one point.
    expect(scented - unscented).toBe(40);
    // Switching the term off collapses the difference.
    const off = { ...prio, pheromoneWeight: 0 };
    expect(
      runPriorityWeight({ ...base, effectivePheromone: 40 }, off, NOW) -
        runPriorityWeight({ ...base, effectivePheromone: 0 }, off, NOW),
    ).toBe(0);
  });

  // Review fix (#1047): the strength is a task field anyone with API access
  // sets up to MAX_PHEROMONE_STRENGTH, so the term must stay inside the band —
  // a huge strength on an engineer task may not outrank a reviewer run, a
  // current-release run, or exceed the budget the band width reserves.
  it("a huge pheromone strength cannot lift a run out of its role band", () => {
    const prio = settings({ currentRelease: "1.6.5" });
    const band = bandOf(prio);
    const hugeEngineer = runPriorityWeight(
      {
        role: "engineer",
        hasIssue: true,
        issuePriority: "critical",
        releaseMatched: false,
        createdAtMs: NOW,
        effectivePheromone: MAX_PHEROMONE_STRENGTH,
      },
      prio,
      NOW,
    );
    const plainReviewer = runPriorityWeight(
      { role: "review", hasIssue: true, issuePriority: "low", releaseMatched: false, createdAtMs: NOW },
      prio,
      NOW,
    );
    const plainRelease = runPriorityWeight(
      { role: "engineer", hasIssue: true, issuePriority: "low", releaseMatched: true, createdAtMs: NOW },
      prio,
      NOW,
    );
    expect(hugeEngineer).toBeLessThan(plainReviewer);
    expect(hugeEngineer).toBeLessThan(plainRelease);
    // the term is capped at the budget: the maximum equals 100 points x weight
    const atBudget = runPriorityWeight(
      {
        role: "engineer",
        hasIssue: true,
        issuePriority: "critical",
        releaseMatched: false,
        createdAtMs: NOW,
        effectivePheromone: RUN_PRIORITY_PHEROMONE_MAX_POINTS,
      },
      prio,
      NOW,
    );
    expect(hugeEngineer).toBe(atBudget);
    expect(hugeEngineer).toBeLessThan(
      (DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.engineer + 1) * band,
    );
  });
});
