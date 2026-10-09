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
  it("with p0Preemption off the queue is strictly oldest-first", () => {
    const ordered = orderSwarmQueueCandidates(
      [
        { issueId: "old-low", priority: "low", queuedAt: "2026-10-02T07:00:00Z" },
        { issueId: "new-critical", priority: "critical", queuedAt: "2026-10-02T11:00:00Z" },
        { issueId: "mid-high", priority: "high", queuedAt: "2026-10-02T09:00:00Z" },
      ],
      { p0Preemption: false },
    );
    expect(ordered.map((c) => c.issueId)).toEqual(["old-low", "mid-high", "new-critical"]);
    // Default keeps the 1.6 order: the critical task is the top.
    const defaulted = orderSwarmQueueCandidates([
      { issueId: "a", priority: "low", queuedAt: "2026-10-02T07:00:00Z" },
      { issueId: "b", priority: "critical", queuedAt: "2026-10-02T11:00:00Z" },
    ]);
    expect(defaulted.map((c) => c.issueId)).toEqual(["b", "a"]);
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
