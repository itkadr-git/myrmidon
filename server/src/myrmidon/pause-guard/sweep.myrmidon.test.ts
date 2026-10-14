// myrmidon(1.6.5 PAUSE-GUARD) — the watchdog of the forgotten-pause guard.
//
// Three blocks:
//
// 1. the decision table, pure: threshold, allowlist, operator-only pauses;
// 2. the pass over a store that behaves exactly like the SQL one, with the
//    wake chain, the activity log and the attention registry injected — the
//    ceiling, the leftover card, the settings precedence and the off switch;
// 3. the SQL store itself, over an embedded Postgres (skipped where the
//    database cannot start, e.g. a container running as root).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { resolvePauseGuardSettings } from "@paperclipai/shared";
import { readPauseGuardSignal, resetPauseGuardSignals, recordPauseGuardSignal } from "./attention.js";
import {
  PAUSE_GUARD_ACTIVITY_ACTION,
  createPauseGuardSweep,
  createPauseGuardStore,
  decidePauseGuardCandidate,
  type PauseGuardCandidate,
  type PauseGuardSweepDeps,
  type PauseGuardStore,
} from "./sweep.js";

const MINUTE = 60 * 1000;
const THRESHOLD_MINUTES = 20;

function minutesAgo(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * MINUTE);
}

// ---------------------------------------------------------------------------
// 1. the rules, pure
// ---------------------------------------------------------------------------

describe("pause guard candidate rules", () => {
  const now = new Date("2026-10-06T09:00:00.000Z");
  const thresholdMs = THRESHOLD_MINUTES * MINUTE;
  const base = { name: "agent-a", status: "paused", pauseReason: "manual", pausedAt: minutesAgo(now, 25) };

  it("lifts an operator pause older than the threshold", () => {
    expect(decidePauseGuardCandidate(base, { now, thresholdMs, allowlist: [] })).toEqual({
      eligible: true,
      reason: "eligible",
    });
  });

  it("leaves a pause younger than the threshold alone", () => {
    const decision = decidePauseGuardCandidate(
      { ...base, pausedAt: minutesAgo(now, THRESHOLD_MINUTES - 1) },
      { now, thresholdMs, allowlist: [] },
    );
    expect(decision).toEqual({ eligible: false, reason: "fresh" });
  });

  it("treats a pause exactly at the threshold as forgotten", () => {
    expect(
      decidePauseGuardCandidate(
        { ...base, pausedAt: minutesAgo(now, THRESHOLD_MINUTES) },
        { now, thresholdMs, allowlist: [] },
      ).eligible,
    ).toBe(true);
  });

  it("skips a name on the allowlist, whatever its case", () => {
    expect(
      decidePauseGuardCandidate({ ...base, name: "Agent-Maint" }, { now, thresholdMs, allowlist: ["agent-maint"] }),
    ).toEqual({ eligible: false, reason: "allowlisted" });
  });

  it("never touches a system pause reason", () => {
    for (const pauseReason of ["budget", "system", "company_archived", "import", null]) {
      expect(
        decidePauseGuardCandidate(
          { ...base, pauseReason },
          { now, thresholdMs, allowlist: [] },
        ),
      ).toEqual({ eligible: false, reason: "not_operator_pause" });
    }
  });

  it("ignores an agent that is not paused at all", () => {
    expect(
      decidePauseGuardCandidate({ ...base, status: "idle" }, { now, thresholdMs, allowlist: [] }),
    ).toEqual({ eligible: false, reason: "not_paused" });
  });

  it("cannot judge a pause with no timestamp and leaves it alone", () => {
    expect(
      decidePauseGuardCandidate({ ...base, pausedAt: null }, { now, thresholdMs, allowlist: [] }),
    ).toEqual({ eligible: false, reason: "unknown_paused_at" });
  });
});

describe("pause guard settings resolution", () => {
  it("keeps the environment as the default until a row is saved", () => {
    const resolved = resolvePauseGuardSettings({
      env: { MYRMIDON_PAUSE_GUARD_THRESHOLD_MIN: "5" },
    });
    expect(resolved.settings.thresholdMinutes).toBe(5);
    expect(resolved.sources.thresholdMinutes).toBe("env");
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.sources.enabled).toBe("default");
    expect(resolved.settings.intervalSec).toBe(600);
    expect(resolved.settings.maxResumesPerPass).toBe(20);
    expect(resolved.settings.allowlist).toEqual([]);
  });

  it("lets the stored row win over the environment", () => {
    const resolved = resolvePauseGuardSettings({
      stored: { enabled: false, thresholdMinutes: 30, intervalSec: 60, allowlist: ["agent-a"], maxResumesPerPass: 3 },
      env: { MYRMIDON_PAUSE_GUARD_THRESHOLD_MIN: "5", MYRMIDON_PAUSE_GUARD_ENABLED: "1" },
    });
    expect(resolved.settings).toEqual({
      enabled: false,
      thresholdMinutes: 30,
      intervalSec: 60,
      allowlist: ["agent-a"],
      maxResumesPerPass: 3,
    });
    expect(resolved.sources.thresholdMinutes).toBe("settings");
    expect(resolved.sources.enabled).toBe("settings");
  });

  it("reads an unusable row as absent instead of trusting it", () => {
    const resolved = resolvePauseGuardSettings({
      stored: { thresholdMinutes: -5, maxResumesPerPass: "many" },
      env: { MYRMIDON_PAUSE_GUARD_THRESHOLD_MIN: "7" },
    });
    expect(resolved.settings.thresholdMinutes).toBe(7);
    expect(resolved.settings.maxResumesPerPass).toBe(20);
  });

  it("does not let a typo switch the fix off", () => {
    expect(resolvePauseGuardSettings({ env: { MYRMIDON_PAUSE_GUARD_ENABLED: "maybe" } }).settings.enabled).toBe(true);
    expect(resolvePauseGuardSettings({ env: { MYRMIDON_PAUSE_GUARD_ENABLED: "off" } }).settings.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. the pass, over a store with the SQL semantics
// ---------------------------------------------------------------------------

interface FakeAgent extends PauseGuardCandidate {
  companyStatus?: string;
}

function isAllowlisted(name: string, allowlist: readonly string[]): boolean {
  const key = name.trim().toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === key);
}

/** The same predicate the SQL store applies, so the pass sees the same rows. */
function qualifies(agent: FakeAgent, cutoffIso: string, allowlist: readonly string[]): boolean {
  if ((agent.companyStatus ?? "active") !== "active") return false;
  if (agent.status !== "paused" || agent.pauseReason !== "manual") return false;
  if (!agent.pausedAt || agent.pausedAt.getTime() >= Date.parse(cutoffIso)) return false;
  return !isAllowlisted(agent.name, allowlist);
}

function createFakeStore(seed: readonly FakeAgent[]): {
  store: PauseGuardStore;
  state: FakeAgent[];
  claimed: string[];
} {
  const state = seed.map((agent) => ({ ...agent }));
  const claimed: string[] = [];
  const store: PauseGuardStore = {
    async listStale({ cutoffIso, allowlist, limit }) {
      return state
        .filter((agent) => qualifies(agent, cutoffIso, allowlist))
        .sort(
          (left, right) =>
            (left.pausedAt?.getTime() ?? 0) - (right.pausedAt?.getTime() ?? 0) || left.id.localeCompare(right.id),
        )
        .slice(0, Math.max(1, limit))
        .map((agent) => ({
          id: agent.id,
          companyId: agent.companyId,
          name: agent.name,
          status: agent.status,
          pauseReason: agent.pauseReason,
          pausedAt: agent.pausedAt,
        }));
    },
    async countByCompany({ cutoffIso, allowlist }) {
      const counts = new Map<string, number>();
      for (const agent of state) {
        if (!qualifies(agent, cutoffIso, allowlist)) continue;
        counts.set(agent.companyId, (counts.get(agent.companyId) ?? 0) + 1);
      }
      return [...counts.entries()].map(([companyId, count]) => ({ companyId, count }));
    },
    async claim({ agentId, cutoffIso }) {
      const agent = state.find((candidate) => candidate.id === agentId);
      if (!agent) return false;
      if (agent.status !== "paused" || agent.pauseReason !== "manual") return false;
      if (!agent.pausedAt || agent.pausedAt.getTime() >= Date.parse(cutoffIso)) return false;
      agent.status = "idle";
      agent.pauseReason = null;
      agent.pausedAt = null;
      claimed.push(agentId);
      return true;
    },
  };
  return { store, state, claimed };
}

function pausedAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    id: randomUUID(),
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "agent-a",
    status: "paused",
    pauseReason: "manual",
    pausedAt: new Date(Date.now() - 25 * MINUTE),
    ...overrides,
  };
}

interface HarnessOptions {
  seed: FakeAgent[];
  env?: Record<string, string | undefined>;
  stored?: unknown;
  /** Replaces the store, for a source that no longer matches the predicate. */
  store?: PauseGuardStore;
}

function harness(options: HarnessOptions) {
  const fake = options.store ? null : createFakeStore(options.seed);
  const store = options.store ?? fake!.store;
  const wakes: string[] = [];
  const activity: Array<{ action: string; agentId: string | null; details: Record<string, unknown> }> = [];
  let stored: unknown = options.stored;

  const deps: PauseGuardSweepDeps = {
    store,
    resumeWake: async (agentId) => {
      wakes.push(agentId);
    },
    readStoredSettings: async () => stored,
    recordAttention: (companyId, signal) => recordPauseGuardSignal(companyId, signal),
    logActivity: async (entry) => {
      activity.push({ action: entry.action, agentId: entry.agentId, details: entry.details });
    },
    // Hermetic: the environment of the test process never leaks in.
    env: options.env ?? {},
  };
  const sweep = createPauseGuardSweep(deps);
  return {
    sweep,
    wakes,
    activity,
    fake,
    setStored: (next: unknown) => {
      stored = next;
    },
  };
}

describe("pause guard sweep", () => {
  const NOW = new Date("2026-10-06T09:00:00.000Z");

  beforeEach(() => {
    resetPauseGuardSignals();
  });

  it("resumes an operator pause older than the threshold and audits it", async () => {
    const stale = pausedAgent({ pausedAt: minutesAgo(NOW, 25) });
    const { sweep, wakes, activity } = harness({ seed: [stale] });

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ scanned: 1, resumed: 1, deferred: 0, skippedChanged: 0, failed: 0 });
    expect(result.agentIds).toEqual([stale.id]);
    expect(wakes).toEqual([stale.id]);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ action: PAUSE_GUARD_ACTIVITY_ACTION, agentId: stale.id });
  });

  it("leaves a pause younger than the threshold alone", async () => {
    const fresh = pausedAgent({ pausedAt: minutesAgo(NOW, 5) });
    const { sweep, wakes, activity } = harness({ seed: [fresh] });

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ scanned: 0, resumed: 0 });
    expect(wakes).toEqual([]);
    expect(activity).toEqual([]);
  });

  it("never lifts a system pause reason", async () => {
    const seed = ["budget", "system", "company_archived", "import"].map((pauseReason, index) =>
      pausedAgent({
        id: `0000000${index}-0000-4000-8000-000000000000`,
        name: `agent-${pauseReason}`,
        pauseReason,
        pausedAt: minutesAgo(NOW, 120),
      }),
    );
    const { sweep, wakes, activity } = harness({ seed });

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ scanned: 0, resumed: 0 });
    expect(wakes).toEqual([]);
    expect(activity).toEqual([]);
  });

  it("skips an allowlisted name and resumes the rest", async () => {
    const maintenance = pausedAgent({ name: "agent-maint", pausedAt: minutesAgo(NOW, 90) });
    const forgotten = pausedAgent({ name: "agent-b", pausedAt: minutesAgo(NOW, 30) });
    const { sweep, wakes } = harness({
      seed: [maintenance, forgotten],
      stored: { allowlist: ["agent-maint"] },
    });

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ scanned: 1, resumed: 1 });
    expect(wakes).toEqual([forgotten.id]);
  });

  it("stops at the per-pass ceiling, keeps the oldest resumes and raises ONE leftover card", async () => {
    const companyId = "22222222-2222-4222-8222-222222222222";
    const seed = Array.from({ length: 25 }, (_, index) =>
      pausedAgent({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        companyId,
        name: `agent-${String(index).padStart(2, "0")}`,
        // Index 0 is the most forgotten pause.
        pausedAt: minutesAgo(NOW, 120 - index),
      }),
    );
    const { sweep, wakes } = harness({ seed, stored: { maxResumesPerPass: 20 } });

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ scanned: 25, resumed: 20, deferred: 5, attentionGroups: 1, failed: 0 });
    expect(wakes).toHaveLength(20);
    expect(wakes[0]).toBe(seed[0]!.id);
    expect(wakes).not.toContain(seed[24]!.id);

    const signal = readPauseGuardSignal(companyId);
    expect(signal).toMatchObject({ companyId, deferredCount: 5, resumedCount: 20, thresholdMinutes: THRESHOLD_MINUTES });
  });

  it("clears the leftover card on the pass that finds nothing left over", async () => {
    const companyId = "33333333-3333-4333-8333-333333333333";
    const seed = Array.from({ length: 3 }, (_, index) =>
      pausedAgent({
        id: `11111111-0000-4000-8000-${String(index).padStart(12, "0")}`,
        companyId,
        name: `agent-${index}`,
        pausedAt: minutesAgo(NOW, 60 - index),
      }),
    );
    const { sweep } = harness({ seed, stored: { maxResumesPerPass: 2 } });

    const first = await sweep.sweep({ now: NOW, force: true });
    expect(first).toMatchObject({ resumed: 2, deferred: 1 });
    expect(readPauseGuardSignal(companyId)?.deferredCount).toBe(1);

    const second = await sweep.sweep({ now: new Date(NOW.getTime() + 5 * MINUTE), force: true });
    expect(second).toMatchObject({ resumed: 1, deferred: 0, attentionGroups: 0 });
    expect(readPauseGuardSignal(companyId)).toBeNull();
  });

  it("lets the stored instance settings win over the environment", async () => {
    const pausedTenMinutesAgo = pausedAgent({ pausedAt: minutesAgo(NOW, 10) });
    const { sweep, wakes, setStored } = harness({
      seed: [pausedTenMinutesAgo],
      env: { MYRMIDON_PAUSE_GUARD_THRESHOLD_MIN: "5" },
      stored: { thresholdMinutes: 30 },
    });

    expect((await sweep.sweep({ now: NOW, force: true })).resumed).toBe(0);
    expect(wakes).toEqual([]);

    // With no saved row the environment applies again: the same pause is old
    // enough for a 5-minute threshold.
    setStored(undefined);
    expect((await sweep.sweep({ now: NOW, force: true })).resumed).toBe(1);
    expect(wakes).toEqual([pausedTenMinutesAgo.id]);
  });

  it("stays out of the way when the operator switched it off", async () => {
    const stale = pausedAgent({ pausedAt: minutesAgo(NOW, 600) });
    const { sweep, wakes, activity } = harness({ seed: [stale], stored: { enabled: false } });

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ scanned: 0, resumed: 0, deferred: 0 });
    expect(wakes).toEqual([]);
    expect(activity).toEqual([]);
  });

  it("honours the interval between two passes and rearms on demand", async () => {
    const stale = pausedAgent({ pausedAt: minutesAgo(NOW, 60) });
    const fresh = pausedAgent({ name: "agent-b", pausedAt: minutesAgo(NOW, 1) });
    const { sweep, wakes, fake } = harness({ seed: [stale, fresh] });

    expect((await sweep.sweep({ now: NOW })).resumed).toBe(1);
    expect(wakes).toEqual([stale.id]);

    // Within the interval nothing runs (the default is 600 s), even though the
    // second agent has since become a forgotten pause.
    fake!.state[1]!.pausedAt = minutesAgo(NOW, 60);
    const soon = new Date(NOW.getTime() + 30 * 1000);
    expect(await sweep.sweep({ now: soon })).toMatchObject({ scanned: 0, resumed: 0 });

    // A settings change arms the next tick instead of waiting the interval out.
    sweep.armNow();
    expect((await sweep.sweep({ now: soon })).resumed).toBe(1);
    expect(wakes).toEqual([stale.id, fresh.id]);
  });

  it("drops a candidate that stopped matching between the query and the claim", async () => {
    const companyId = "44444444-4444-4444-8444-444444444444";
    const candidate = pausedAgent({ companyId, pausedAt: minutesAgo(NOW, 60) });
    const lyingStore: PauseGuardStore = {
      async listStale() {
        return [candidate];
      },
      async countByCompany() {
        return [{ companyId, count: 1 }];
      },
      async claim() {
        throw new Error("the pass must not claim a candidate that no longer qualifies");
      },
    };
    // The board re-paused the agent for its own reason while the pass ran.
    const { sweep, wakes } = harness({
      seed: [candidate],
      store: lyingStore,
    });
    candidate.pauseReason = "budget";

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ scanned: 1, resumed: 0, skippedChanged: 1, failed: 0 });
    expect(wakes).toEqual([]);
  });

  it("counts a resume as done even when its wake chain refuses", async () => {
    const stale = pausedAgent({ pausedAt: minutesAgo(NOW, 60) });
    const { store } = createFakeStore([stale]);
    const sweep = createPauseGuardSweep({
      store,
      resumeWake: async () => {
        throw new Error("wake refused");
      },
      env: {},
    });

    const result = await sweep.sweep({ now: NOW, force: true });

    expect(result).toMatchObject({ resumed: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// 3. the SQL store
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pause guard SQL store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-pause-guard-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(status = "active") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
      status,
    });
    return companyId;
  }

  async function seedAgent(input: {
    companyId: string;
    name: string;
    status?: string;
    pauseReason?: string | null;
    pausedAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "paused",
      pauseReason: input.pauseReason ?? "manual",
      pausedAt: input.pausedAt ?? null,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  it("lists only the forgotten operator pauses of an active company, oldest first", async () => {
    const now = new Date();
    const legacy = await seedCompany("archived");
    const companyId = await seedCompany();
    const oldest = await seedAgent({ companyId, name: "agent-oldest", pausedAt: minutesAgo(now, 90) });
    const newer = await seedAgent({ companyId, name: "agent-newer", pausedAt: minutesAgo(now, 30) });
    await seedAgent({ companyId, name: "agent-maint", pausedAt: minutesAgo(now, 95) });
    await seedAgent({ companyId, name: "agent-fresh", pausedAt: minutesAgo(now, 5) });
    await seedAgent({ companyId, name: "agent-budget", pauseReason: "budget", pausedAt: minutesAgo(now, 95) });
    await seedAgent({ companyId, name: "agent-idle", status: "idle", pausedAt: minutesAgo(now, 95) });
    await seedAgent({ companyId: legacy, name: "agent-archived", pausedAt: minutesAgo(now, 95) });

    const store = createPauseGuardStore(db);
    const cutoffIso = new Date(now.getTime() - THRESHOLD_MINUTES * MINUTE).toISOString();

    const listed = await store.listStale({ cutoffIso, allowlist: ["agent-maint"], limit: 10 });
    expect(listed.map((agent) => agent.id)).toEqual([oldest, newer]);

    const counts = await store.countByCompany({ cutoffIso, allowlist: ["agent-maint"] });
    expect(counts).toEqual([{ companyId, count: 2 }]);
  });

  it("claims a pause once and only while it still matches", async () => {
    const now = new Date();
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, name: "agent-a", pausedAt: minutesAgo(now, 60) });
    const store = createPauseGuardStore(db);
    const cutoffIso = new Date(now.getTime() - THRESHOLD_MINUTES * MINUTE).toISOString();

    expect(await store.claim({ agentId, cutoffIso, now })).toBe(true);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row).toMatchObject({ status: "idle", pauseReason: null, pausedAt: null });

    // The pause is gone: a second pass can no longer claim it.
    expect(await store.claim({ agentId, cutoffIso, now })).toBe(false);

    // A pause the board set for its own reason is never claimable.
    const budgetId = await seedAgent({ companyId, name: "agent-b", pauseReason: "budget", pausedAt: minutesAgo(now, 60) });
    expect(await store.claim({ agentId: budgetId, cutoffIso, now })).toBe(false);

    // Neither is a pause younger than the threshold.
    const freshId = await seedAgent({ companyId, name: "agent-c", pausedAt: minutesAgo(now, 1) });
    expect(await store.claim({ agentId: freshId, cutoffIso, now })).toBe(false);
  });
});