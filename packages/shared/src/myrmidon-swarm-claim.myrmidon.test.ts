// myrmidon(1.6-SWARM): the shared contract of per-role queues with leased
// claims. These tests pin the decisions the core queue and the supervisor view
// share — the queue order, the lease states, the settings precedence and the
// per-agent ceiling — so a later change to one of them cannot drift past them.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWARM_CLAIM_ENABLED,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  SWARM_CLAIM_ENV_KEYS,
  SWARM_CLAIM_RELEASE_REASON_SUPERVISOR_REBALANCE,
  SWARM_CLAIM_SUPERVISOR_RELEASED_ACTION,
  SWARM_CLAIM_WAKE_REASON,
  isSwarmClaimEnabledFor,
  isSwarmLeaseExpired,
  isSwarmLeaseLive,
  mergeSwarmClaimSettings,
  normalizeSwarmClaimSettings,
  orderSwarmQueueCandidates,
  parseSwarmClaimEnabled,
  readSwarmClaimSettingsFromEnv,
  resolveSwarmClaimSettings,
  swarmActiveTaskLimitReached,
  swarmLeaseExpiresAt,
  swarmPriorityRank,
  DEFAULT_PHEROMONE_DYNAMICS,
  effectivePheromone,
  pheromoneDynamicsOf,
  pheromoneStrengthForPriority,
} from "./myrmidon-swarm-claim.js";

describe("swarm claim settings", () => {
  it("ships the swarm dark and reads an explicit on", () => {
    expect(DEFAULT_SWARM_CLAIM_ENABLED).toBe(false);
    expect(readSwarmClaimSettingsFromEnv({}).enabled).toBe(false);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "1" }).enabled).toBe(true);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "on" }).enabled).toBe(true);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "false" }).enabled).toBe(false);
    // A typo must not silently extinguish (or enable) the swarm.
    expect(parseSwarmClaimEnabled("ture")).toBeNull();
    expect(parseSwarmClaimEnabled(" 1 ")).toBe(true);
  });

  it("uses the documented defaults for the lease, the ceiling and the sweep", () => {
    const settings = readSwarmClaimSettingsFromEnv({});
    expect(settings.leaseTtlSec).toBe(DEFAULT_SWARM_LEASE_TTL_SEC);
    expect(settings.maxActiveTasks).toBe(DEFAULT_SWARM_MAX_ACTIVE_TASKS);
    expect(settings.sweepIntervalSec).toBe(DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC);
  });

  it("reads the environment values and refuses out-of-range ones", () => {
    const settings = readSwarmClaimSettingsFromEnv({
      [SWARM_CLAIM_ENV_KEYS.leaseTtlSec]: "120",
      [SWARM_CLAIM_ENV_KEYS.maxActiveTasks]: "1",
      [SWARM_CLAIM_ENV_KEYS.sweepIntervalSec]: "10",
    });
    expect(settings).toMatchObject({ leaseTtlSec: 120, maxActiveTasks: 1, sweepIntervalSec: 10 });

    // Out of range falls back to the default, it never becomes a wider window.
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.leaseTtlSec]: "10" }).leaseTtlSec).toBe(
      DEFAULT_SWARM_LEASE_TTL_SEC,
    );
    expect(
      readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.maxActiveTasks]: "0" }).maxActiveTasks,
    ).toBeNull();
  });

  it("an environment override beats the stored value; without one the stored value is in force", () => {
    // 1.6.1 (SWARM-SETTINGS-UI): the env variables are forced overrides, not
    // first-boot defaults — an operator can pin a contour without touching
    // the database. The stored row is the UI value and wins whenever the
    // variable is unset.
    const stored = {
      enabled: true,
      leaseTtlSec: 300,
      maxActiveTasks: 5,
      sweepIntervalSec: 45,
      p0Preemption: false,
      pheromone: {},
    };
    const forcedOff = resolveSwarmClaimSettings({
      stored,
      env: { [SWARM_CLAIM_ENV_KEYS.enabled]: "0" },
    });
    expect(forcedOff.settings.enabled).toBe(false);
    // Only the overridden key changes; the rest keep the stored values.
    expect(forcedOff.settings.leaseTtlSec).toBe(300);
    expect(forcedOff.sources.enabled).toBe("env");
    expect(forcedOff.sources.leaseTtlSec).toBe("settings");

    const uiWins = resolveSwarmClaimSettings({ stored, env: {} });
    expect(uiWins.settings).toEqual(stored);
    expect(uiWins.sources.enabled).toBe("settings");

    const fromEnv = resolveSwarmClaimSettings({
      stored: { enabled: "maybe" },
      env: { [SWARM_CLAIM_ENV_KEYS.enabled]: "1" },
    });
    expect(fromEnv.settings.enabled).toBe(true);
    expect(fromEnv.sources.enabled).toBe("env");

    expect(resolveSwarmClaimSettings({}).sources.enabled).toBe("default");
    expect(normalizeSwarmClaimSettings({ enabled: true })).toBeNull();
  });

  it("merges a patch without dropping the keys it does not name", () => {
    const base = readSwarmClaimSettingsFromEnv({});
    expect(mergeSwarmClaimSettings(base, { enabled: true })).toEqual({ ...base, enabled: true });
    expect(mergeSwarmClaimSettings(base, { maxActiveTasks: null }).maxActiveTasks).toBeNull();
  });

  it("moves the expiry forward by exactly one TTL", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    expect(swarmLeaseExpiresAt(now, { leaseTtlSec: 900 }).toISOString()).toBe(
      "2026-10-02T12:15:00.000Z",
    );
  });
});

describe("swarm active task ceiling", () => {
  it("is reached at the ceiling and off when the setting is null", () => {
    expect(swarmActiveTaskLimitReached(2, { maxActiveTasks: 3 })).toBe(false);
    expect(swarmActiveTaskLimitReached(3, { maxActiveTasks: 3 })).toBe(true);
    expect(swarmActiveTaskLimitReached(999, { maxActiveTasks: null })).toBe(false);
  });
});

describe("swarm queue order", () => {
  it("puts a critical task at the top of the queue", () => {
    const ordered = orderSwarmQueueCandidates([
      { issueId: "a", priority: "low", queuedAt: "2026-10-02T09:00:00Z" },
      { issueId: "b", priority: "critical", queuedAt: "2026-10-02T11:00:00Z" },
      { issueId: "c", priority: "high", queuedAt: "2026-10-02T08:00:00Z" },
    ]);
    expect(ordered.map((c) => c.issueId)).toEqual(["b", "c", "a"]);
    expect(swarmPriorityRank("critical")).toBeLessThan(swarmPriorityRank("high"));
    expect(swarmPriorityRank(null)).toBe(4);
  });

  it("breaks a priority tie by the older queue entry", () => {
    const ordered = orderSwarmQueueCandidates([
      { issueId: "newer", priority: "high", queuedAt: "2026-10-02T11:00:00Z" },
      { issueId: "older", priority: "high", queuedAt: "2026-10-02T07:00:00Z" },
    ]);
    expect(ordered.map((c) => c.issueId)).toEqual(["older", "newer"]);
  });

  it("does not mutate the input", () => {
    const input = [
      { issueId: "a", priority: "low", queuedAt: 0 } as const,
      { issueId: "b", priority: "critical", queuedAt: 0 } as const,
    ];
    orderSwarmQueueCandidates(input);
    expect(input[0].issueId).toBe("a");
  });

  // 1.6.1 (SWARM-SETTINGS-UI): the P0 preemption is a setting, not a constant.
  it("with p0Preemption off the queue orders by strength, then age", () => {
    const ordered = orderSwarmQueueCandidates(
      [
        { issueId: "old-low", priority: "low", queuedAt: "2026-10-02T07:00:00Z", pheromoneStrength: 10 },
        { issueId: "new-critical", priority: "critical", queuedAt: "2026-10-02T11:00:00Z", pheromoneStrength: 90 },
        { issueId: "mid-high", priority: "high", queuedAt: "2026-10-02T09:00:00Z", pheromoneStrength: 50 },
      ],
      { p0Preemption: false },
    );
    expect(ordered.map((c) => c.issueId)).toEqual(["new-critical", "mid-high", "old-low"]);
    // Default keeps the 1.6 order: the critical task is the top.
    const defaulted = orderSwarmQueueCandidates([
      { issueId: "a", priority: "low", queuedAt: "2026-10-02T07:00:00Z" },
      { issueId: "b", priority: "critical", queuedAt: "2026-10-02T11:00:00Z" },
    ]);
    expect(defaulted.map((c) => c.issueId)).toEqual(["b", "a"]);
  });

  // 1.6.5 (F-27 PHEROMONE): the strength ranks inside the P0 band.
  it("orders by pheromone strength inside the same priority band", () => {
    const ordered = orderSwarmQueueCandidates([
      { issueId: "weak", priority: "medium", queuedAt: "2026-10-02T07:00:00Z", pheromoneStrength: 10 },
      { issueId: "strong", priority: "medium", queuedAt: "2026-10-02T11:00:00Z", pheromoneStrength: 90 },
      { issueId: "unscented", priority: "medium", queuedAt: "2026-10-02T06:00:00Z" },
    ]);
    expect(ordered.map((c) => c.issueId)).toEqual(["strong", "weak", "unscented"]);
  });

  it("a critical task with no strength still preempts a strong medium task", () => {
    const ordered = orderSwarmQueueCandidates([
      { issueId: "strong-medium", priority: "medium", queuedAt: "2026-10-02T07:00:00Z", pheromoneStrength: 500 },
      { issueId: "plain-p0", priority: "critical", queuedAt: "2026-10-02T11:00:00Z" },
    ]);
    expect(ordered.map((c) => c.issueId)).toEqual(["plain-p0", "strong-medium"]);
  });

  it("a strength tie falls to the older queue entry", () => {
    const ordered = orderSwarmQueueCandidates([
      { issueId: "newer", priority: "high", queuedAt: "2026-10-02T11:00:00Z", pheromoneStrength: 40 },
      { issueId: "older", priority: "high", queuedAt: "2026-10-02T07:00:00Z", pheromoneStrength: 40 },
    ]);
    expect(ordered.map((c) => c.issueId)).toEqual(["older", "newer"]);
  });
});

// 1.6.5 (F-27 rework 09.10, design §2.3): the effective strength — the stored
// pheromone plus the aging (capped), minus the penalty per failed run without
// a task change. The queue, the idle wake and the supervisor all rank by it.
describe("effectivePheromone", () => {
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  const HOURS = 3_600_000;

  it("no wait and no failures: the effective strength is the stored strength", () => {
    expect(
      effectivePheromone({ pheromoneStrength: 10, queuedAt: NOW }, DEFAULT_PHEROMONE_DYNAMICS, NOW),
    ).toBe(10);
  });

  it("ages one step per agingStepHours of waiting, capped by agingCap", () => {
    // 3 days = 3 steps of the 24-hour default.
    expect(
      effectivePheromone(
        { pheromoneStrength: 10, queuedAt: new Date(NOW.getTime() - 72 * HOURS) },
        DEFAULT_PHEROMONE_DYNAMICS,
        NOW,
      ),
    ).toBe(13);
    // Past the cap the wait stops paying: 10 days = 10 steps, capped at 5.
    expect(
      effectivePheromone(
        { pheromoneStrength: 10, queuedAt: new Date(NOW.getTime() - 240 * HOURS) },
        DEFAULT_PHEROMONE_DYNAMICS,
        NOW,
      ),
    ).toBe(15);
    // The knobs are settings, not constants.
    expect(
      effectivePheromone(
        { pheromoneStrength: 10, queuedAt: new Date(NOW.getTime() - 48 * HOURS) },
        { agingStepHours: 12, agingStep: 2, agingCap: 100, failPenalty: 10 },
        NOW,
      ),
    ).toBe(18);
  });

  it("a failed run without a task change costs failPenalty; two cost twice", () => {
    expect(
      effectivePheromone(
        { pheromoneStrength: 30, queuedAt: NOW, failedRunsSinceLastChange: 1 },
        DEFAULT_PHEROMONE_DYNAMICS,
        NOW,
      ),
    ).toBe(20);
    expect(
      effectivePheromone(
        { pheromoneStrength: 30, queuedAt: NOW, failedRunsSinceLastChange: 2 },
        DEFAULT_PHEROMONE_DYNAMICS,
        NOW,
      ),
    ).toBe(10);
    // The penalty may not drag the effective strength below zero.
    expect(
      effectivePheromone(
        { pheromoneStrength: 5, queuedAt: NOW, failedRunsSinceLastChange: 3 },
        DEFAULT_PHEROMONE_DYNAMICS,
        NOW,
      ),
    ).toBe(0);
  });

  it("aging and the penalty compose: an old task with failures nets both", () => {
    // 2 days waiting (+2), one failure (−10): 10 + 2 − 10 = 2.
    expect(
      effectivePheromone(
        {
          pheromoneStrength: 10,
          queuedAt: new Date(NOW.getTime() - 48 * HOURS),
          failedRunsSinceLastChange: 1,
        },
        DEFAULT_PHEROMONE_DYNAMICS,
        NOW,
      ),
    ).toBe(2);
  });

  // Acceptance: a task waiting 3 days overtakes a fresh one with strength +2.
  it("acceptance: 3 days of aging overtakes a fresh task with strength +2", () => {
    const oldTask = {
      pheromoneStrength: 10,
      queuedAt: new Date(NOW.getTime() - 72 * HOURS),
    };
    const freshTask = { pheromoneStrength: 12, queuedAt: NOW };
    expect(
      effectivePheromone(oldTask, DEFAULT_PHEROMONE_DYNAMICS, NOW),
    ).toBeGreaterThan(effectivePheromone(freshTask, DEFAULT_PHEROMONE_DYNAMICS, NOW));
    // …and the queue ordering takes the overtaking: the old task is the top.
    const ordered = orderSwarmQueueCandidates(
      [
        { issueId: "fresh", priority: "medium", queuedAt: NOW, pheromoneStrength: 12 },
        { issueId: "old", priority: "medium", queuedAt: oldTask.queuedAt, pheromoneStrength: 10 },
      ],
      { p0Preemption: false, dynamics: DEFAULT_PHEROMONE_DYNAMICS, now: NOW },
    );
    expect(ordered.map((c) => c.issueId)).toEqual(["old", "fresh"]);
  });

  // Acceptance: after 2 failed runs without changes a task drops below an
  // otherwise equal one.
  it("acceptance: two failures without a change drop a task below an equal one", () => {
    const ordered = orderSwarmQueueCandidates(
      [
        { issueId: "failed", priority: "medium", queuedAt: NOW, pheromoneStrength: 10, failedRunsSinceLastChange: 2 },
        { issueId: "clean", priority: "medium", queuedAt: NOW, pheromoneStrength: 10 },
      ],
      { p0Preemption: false, dynamics: DEFAULT_PHEROMONE_DYNAMICS, now: NOW },
    );
    expect(ordered.map((c) => c.issueId)).toEqual(["clean", "failed"]);
  });

  // The knobs come from the one `pheromone` settings key; absent = the design default.
  it("reads the dynamics and the priority seeds from the pheromone settings key", () => {
    expect(pheromoneDynamicsOf({})).toEqual(DEFAULT_PHEROMONE_DYNAMICS);
    expect(pheromoneDynamicsOf(undefined)).toEqual(DEFAULT_PHEROMONE_DYNAMICS);
    expect(pheromoneDynamicsOf({ agingCap: 9, failPenalty: 3 })).toEqual({
      ...DEFAULT_PHEROMONE_DYNAMICS,
      agingCap: 9,
      failPenalty: 3,
    });
    expect(pheromoneStrengthForPriority({}, "high")).toBe(30);
    expect(pheromoneStrengthForPriority({ high: 77 }, "HIGH")).toBe(77);
    // An unknown priority reads as medium.
    expect(pheromoneStrengthForPriority({ medium: 12 }, "none")).toBe(12);
    expect(pheromoneStrengthForPriority(null, null)).toBe(10);
  });

  // Acceptance: a strong fresh task stands ahead of old weak ones.
  it("acceptance: a strong fresh task is ahead of old weak ones", () => {
    const ordered = orderSwarmQueueCandidates(
      [
        { issueId: "old-weak-1", priority: "medium", queuedAt: new Date(NOW.getTime() - 96 * HOURS), pheromoneStrength: 10 },
        { issueId: "old-weak-2", priority: "medium", queuedAt: new Date(NOW.getTime() - 200 * HOURS), pheromoneStrength: 10 },
        { issueId: "fresh-strong", priority: "medium", queuedAt: NOW, pheromoneStrength: 100 },
      ],
      { dynamics: DEFAULT_PHEROMONE_DYNAMICS, now: NOW },
    );
    expect(ordered.map((c) => c.issueId)).toEqual(["fresh-strong", "old-weak-2", "old-weak-1"]);
  });

  // Equal effective strength and age: the id makes the order total.
  it("ties on strength and age fall to the issue id", () => {
    const ordered = orderSwarmQueueCandidates(
      [
        { issueId: "b", priority: "medium", queuedAt: NOW, pheromoneStrength: 10 },
        { issueId: "a", priority: "medium", queuedAt: NOW, pheromoneStrength: 10 },
      ],
      { now: NOW },
    );
    expect(ordered.map((c) => c.issueId)).toEqual(["a", "b"]);
  });
});


// myrmidon(1.6.5 SWARM-T4, design §5.1): one switch, no role/company lists.
describe("swarm claim gate", () => {
  const on = {
    enabled: true,
    leaseTtlSec: 900,
    maxActiveTasks: 3 as number | null,
    sweepIntervalSec: 30,
    p0Preemption: true,
    pheromone: {},
  };

  it("with the switch on every company and role is inside", () => {
    expect(isSwarmClaimEnabledFor(on, { companyId: "any", role: "any" })).toBe(true);
  });

  it("the master switch off overrides everything", () => {
    expect(isSwarmClaimEnabledFor({ ...on, enabled: false }, { companyId: "comp-1", role: "engineer" })).toBe(false);
  });
});

// myrmidon(1.6.5 SWARM-T4, design §5.1): the pheromone subset.
describe("swarm pheromone settings", () => {
  it("accepts a partial pheromone object and defaults the rest to {}", () => {
    const base = { enabled: true, leaseTtlSec: 900, maxActiveTasks: 3, sweepIntervalSec: 30 };
    expect(normalizeSwarmClaimSettings({ ...base, pheromone: { critical: 250 } })?.pheromone).toEqual({
      critical: 250,
    });
    expect(normalizeSwarmClaimSettings(base)?.pheromone).toEqual({});
  });

  it("rejects unknown pheromone keys and negative values", () => {
    const base = { enabled: true, leaseTtlSec: 900, maxActiveTasks: 3, sweepIntervalSec: 30 };
    expect(normalizeSwarmClaimSettings({ ...base, pheromone: { surprise: 1 } })).toBeNull();
    expect(normalizeSwarmClaimSettings({ ...base, pheromone: { critical: -1 } })).toBeNull();
  });

  it("merges a pheromone patch like any other key", () => {
    const base = readSwarmClaimSettingsFromEnv({});
    const merged = mergeSwarmClaimSettings(base, { pheromone: { critical: 250 } });
    expect(merged.pheromone).toEqual({ critical: 250 });
    expect(mergeSwarmClaimSettings(base, { enabled: true }).enabled).toBe(true);
  });
});
