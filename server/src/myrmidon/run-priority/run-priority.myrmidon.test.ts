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
  normalizeRunPrioritySettings,
  readRunPriorityFromEnv,
  releaseTagMatches,
  runPriorityWeight,
  type RunPrioritySettings,
} from "@paperclipai/shared";
import {
  compareRunsByPriority,
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

describe("runPriorityWeight", () => {
  const base = settings();

  it("scores a review role above an engineer and a critical issue above both", () => {
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
    // weight = max(role, issue): engineer(50) loses to the medium issue (60)
    expect(engineer).toBe(DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS.medium);
    // review(90) beats the same issue weight — the role carries the run
    expect(reviewer).toBe(DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.review);
    expect(reviewer).toBeGreaterThan(engineer);
    // weight = max(role, issue): the critical issue outranks its own role
    expect(criticalEngineer).toBe(DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS.critical);
  });

  it("gives a run without an issue only its role weight", () => {
    const w = runPriorityWeight(
      { role: "engineer", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW },
      base,
      NOW,
    );
    expect(w).toBe(DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS.engineer);
  });

  it("pays the release bonus to a run whose issue carries the current release", () => {
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
    expect(withRelease - without).toBe(base.releaseBonus);
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
    // 100-minute wait would otherwise short-circuit to the top weight
    const noEscape = { ...base, starvationLimitMinutes: 0 };
    expect(runPriorityWeight(input(120), noEscape, NOW) - runPriorityWeight(input(0), noEscape, NOW)).toBe(
      noEscape.agingMaxBonus,
    );
    // the starvation escape short-circuits aging: past the 90-minute limit the
    // run gets the top weight outright, cap included
    expect(runPriorityWeight(input(100), base, NOW)).toBe(base.starvationTopWeight);
    expect(runPriorityWeight(input(90), base, NOW)).toBe(base.starvationTopWeight);
  });

  it("grants the top weight past the starvation limit, and nothing when the limit is off", () => {
    const starved = runPriorityWeight(
      { role: "general", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW - 91 * MIN },
      base,
      NOW,
    );
    expect(starved).toBe(base.starvationTopWeight);
    const noLimit = settings({ starvationLimitMinutes: 0 });
    const stillAging = runPriorityWeight(
      { role: "general", hasIssue: false, issuePriority: null, releaseMatched: false, createdAtMs: NOW - 91 * MIN },
      noLimit,
      NOW,
    );
    expect(stillAging).toBeLessThan(noLimit.starvationTopWeight);
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
    // reviewer = max(90 role, 60 issue) = 90; engineer = max(50, 60) + aging cap 50 = 110? No:
    // the 500-minute wait hits the starvation escape first, so compare at a
    // pre-escape wait where the role difference must decide the order
    const freshEngineer = scored("eng", "engineer", "medium", 5);
    expect(compareRunsByPriority(reviewer, freshEngineer, base, NOW)).toBeLessThan(0);
    expect(compareRunsByPriority(reviewer, engineer, base, NOW)).toBeGreaterThan(0);
    // equal weights fall back to the FIFO order the queue had before
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
    // lead role weight (80) covers every issue weight up to high (80), within one aging step, so the
    // weights alone tie; the per-agent tie-break must keep high ahead of low.
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
});
