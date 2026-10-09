// myrmidon(1.6-SWARM): the shared contract of per-role queues with leased
// claims. These tests pin the decisions the core queue and the supervisor view
// share — the queue order, the lease states, the settings precedence and the
// per-agent ceiling — so a later change to one of them cannot drift past them.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWARM_CLAIM_ENABLED,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  DEFAULT_SWARM_IDLE_WAKE_BATCH,
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  MAX_SWARM_IDLE_WAKE_BATCH,
  MIN_SWARM_IDLE_WAKE_BATCH,
  SWARM_CLAIM_ENV_KEYS,
  SWARM_CLAIM_IDLE_WAKE_BATCH_ENV,
  SWARM_CLAIM_RELEASE_REASON_SUPERVISOR_REBALANCE,
  SWARM_CLAIM_SUPERVISOR_RELEASED_ACTION,
  SWARM_CLAIM_WAKE_REASON,
  isSwarmClaimEnabledFor,
  isSwarmLeaseExpired,
  isSwarmLeaseLive,
  mergeSwarmClaimSettings,
  normalizeSwarmClaimSettings,
  orderSwarmQueueCandidates,
  orderIdleWakeAgents,
  parseSwarmClaimEnabled,
  readSwarmClaimListEnv,
  readSwarmClaimSettingsFromEnv,
  resolveSwarmClaimSettings,
  resolveSwarmQueueEligibility,
  SWARM_CLAIM_SETTING_KEYS,
  swarmActiveTaskLimitReached,
  swarmLeaseExpiresAt,
  swarmPriorityRank,
} from "./myrmidon-swarm-claim.js";

describe("swarm claim settings", () => {
  it("ships the pilot dark and reads an explicit on", () => {
    expect(DEFAULT_SWARM_CLAIM_ENABLED).toBe(false);
    expect(readSwarmClaimSettingsFromEnv({}).enabled).toBe(false);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "1" }).enabled).toBe(true);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "on" }).enabled).toBe(true);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "false" }).enabled).toBe(false);
    // A typo must not silently extinguish (or enable) the pilot.
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
      enabledRoles: ["engineer"],
      enabledCompanyIds: [],
      leaseTtlSec: 300,
      maxActiveTasks: 5,
      sweepIntervalSec: 45,
      p0Preemption: false,
      // 1.6.5 (OPE-6608 D): the idle-wake batch is a stored setting now.
      idleWakeBatch: 5,
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

// 1.6.1 (SWARM-SETTINGS-UI): the pilot set — who is inside the pilot.
describe("swarm claim pilot set", () => {
  const on = {
    enabled: true,
    enabledRoles: ["engineer"],
    enabledCompanyIds: ["comp-1"],
    leaseTtlSec: 900,
    maxActiveTasks: 3 as number | null,
    sweepIntervalSec: 30,
    p0Preemption: true,
  };

  it("an empty list means no restriction", () => {
    expect(
      isSwarmClaimEnabledFor(
        { ...on, enabledRoles: [], enabledCompanyIds: [] },
        { companyId: "any", role: "any" },
      ),
    ).toBe(true);
  });

  it("a role not on the list is outside the pilot", () => {
    expect(isSwarmClaimEnabledFor(on, { companyId: "comp-1", role: "engineer" })).toBe(true);
    expect(isSwarmClaimEnabledFor(on, { companyId: "comp-1", role: "reviewer" })).toBe(false);
  });

  it("a company not on the list is outside the pilot", () => {
    expect(isSwarmClaimEnabledFor(on, { companyId: "comp-2", role: "engineer" })).toBe(false);
  });

  it("the master switch off overrides everything", () => {
    expect(isSwarmClaimEnabledFor({ ...on, enabled: false }, { companyId: "comp-1", role: "engineer" })).toBe(false);
  });

  it("the env list override is comma-separated and trimmed", () => {
    expect(readSwarmClaimListEnv(" engineer , reviewer ,, ")).toEqual(["engineer", "reviewer"]);
    expect(readSwarmClaimListEnv("")).toEqual([]);
    expect(readSwarmClaimListEnv(undefined)).toEqual([]);
  });
});

describe("swarm lease state", () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  const base = { id: "l1", issueId: "i1", agentId: "a1", heartbeatAt: now };

  it("is live before the expiry and expired at or after it", () => {
    const live = { ...base, expiresAt: "2026-10-02T12:05:00.000Z", releasedAt: null };
    expect(isSwarmLeaseLive(live, now)).toBe(true);
    expect(isSwarmLeaseExpired(live, now)).toBe(false);

    const expired = { ...base, expiresAt: "2026-10-02T11:59:59.000Z", releasedAt: null };
    expect(isSwarmLeaseLive(expired, now)).toBe(false);
    expect(isSwarmLeaseExpired(expired, now)).toBe(true);
  });

  it("treats a released lease as neither live nor expired", () => {
    const released = {
      ...base,
      expiresAt: "2026-10-02T12:05:00.000Z",
      releasedAt: "2026-10-02T11:50:00.000Z",
    };
    expect(isSwarmLeaseLive(released, now)).toBe(false);
    expect(isSwarmLeaseExpired(released, now)).toBe(false);
  });

  it("does not call a lease without an expiry live", () => {
    expect(isSwarmLeaseLive({ ...base, expiresAt: null, releasedAt: null }, now)).toBe(false);
  });
});

describe("swarm names shared with the supervisor part", () => {
  it("pins the wake reason and the supervisor action the two parts agree on", () => {
    expect(SWARM_CLAIM_WAKE_REASON).toBe("swarm_claim_queue");
    expect(SWARM_CLAIM_RELEASE_REASON_SUPERVISOR_REBALANCE).toBe("supervisor_rebalance");
    expect(SWARM_CLAIM_SUPERVISOR_RELEASED_ACTION).toBe("issue.swarm_claim.supervisor_released");
  });

  // 1.6.5 (OPE-6608 SWARM-WAKE-FIX B): who the idle pass wakes, in what order.
  it("wakes the least loaded agent first and never keeps one agent at the head", () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const busy = { id: "a-busy", activeClaims: 3, lastActiveAt: new Date(now.getTime() - 60_000) };
    const fresh = { id: "b-fresh", activeClaims: 0, lastActiveAt: new Date(now.getTime() - 30_000) };
    const stale = { id: "c-stale", activeClaims: 0, lastActiveAt: new Date(now.getTime() - 4 * 3600_000) };
    const never = { id: "d-never", activeClaims: 0, lastActiveAt: null };
    const input = [busy, fresh, stale, never];

    const ordered = orderIdleWakeAgents(input).map((agent) => agent.id);
    // Idle before loaded, and among the idle the one that has waited longest —
    // an agent that never ran is the idlest of all, so the head of the list
    // rotates instead of staying the same five `agents` rows on every pass.
    expect(ordered).toEqual(["d-never", "c-stale", "b-fresh", "a-busy"]);
    // The read order is not mutated for the caller.
    expect(input.map((agent) => agent.id)).toEqual(["a-busy", "b-fresh", "c-stale", "d-never"]);
  });

  it("keeps the read order for agents that are equally idle", () => {
    const same = new Date("2026-10-09T11:00:00.000Z");
    const ordered = orderIdleWakeAgents([
      { id: "a", activeClaims: 1, lastActiveAt: same },
      { id: "b", activeClaims: 1, lastActiveAt: same },
    ]);
    expect(ordered.map((agent) => agent.id)).toEqual(["a", "b"]);
  });

  // 1.6.5 (OPE-6608 SWARM-WAKE-FIX C): who may take from the queue at all.
  it("keeps leads out of the queue by default and lets the agent card decide", () => {
    expect(resolveSwarmQueueEligibility({ casteEligible: true, hasDirectReports: false })).toEqual({
      eligible: true,
      source: "caste",
    });
    // A lead, a reviewer, an architect: the directory calls them all `engineer`,
    // so the manager fact is what keeps them out.
    expect(resolveSwarmQueueEligibility({ casteEligible: true, hasDirectReports: true })).toEqual({
      eligible: false,
      source: "caste",
    });
    expect(resolveSwarmQueueEligibility({ casteEligible: false, hasDirectReports: false })).toEqual({
      eligible: false,
      source: "caste",
    });
    // The switch in the agent card wins in both directions.
    expect(
      resolveSwarmQueueEligibility({
        metadata: { swarmQueueEligible: false },
        casteEligible: true,
        hasDirectReports: false,
      }),
    ).toEqual({ eligible: false, source: "agent" });
    expect(
      resolveSwarmQueueEligibility({
        metadata: { swarmQueueEligible: true },
        casteEligible: true,
        hasDirectReports: true,
      }),
    ).toEqual({ eligible: true, source: "agent" });
    // Garbage in the switch is ignored rather than read as "off".
    expect(
      resolveSwarmQueueEligibility({
        metadata: { swarmQueueEligible: "maybe" },
        casteEligible: true,
        hasDirectReports: false,
      }),
    ).toEqual({ eligible: true, source: "caste" });
  });

  // 1.6.5 (OPE-6608 SWARM-WAKE-FIX D): the batch is a stored setting now.
  it("lists the idle wake batch among the settings the panel edits", () => {
    expect(SWARM_CLAIM_SETTING_KEYS).toContain("idleWakeBatch");
    expect(DEFAULT_SWARM_IDLE_WAKE_BATCH).toBe(5);
    expect(MIN_SWARM_IDLE_WAKE_BATCH).toBe(1);
    expect(MAX_SWARM_IDLE_WAKE_BATCH).toBe(25);
    expect(SWARM_CLAIM_IDLE_WAKE_BATCH_ENV).toBe("MYRMIDON_SWARM_IDLE_WAKE_BATCH");
  });
});