// server/src/myrmidon/session-generations/session-generations.myrmidon.test.ts
//
// myrmidon(PERF-DIET-K): the session-generation core, its thresholds, its
// in-memory cache and the resolver the run dispatch calls.
//
// The watchdog of the acceptance criteria: the key gains the generation when a
// threshold is crossed (activity OR age), the generation continues while it is
// inside its thresholds, and the feature never touches another adapter,
// another session-key strategy or a wake without a task.

import { describe, expect, it, vi } from "vitest";

import {
  createSessionGenerationCache,
  createSessionGenerationResolver,
  decideSessionGeneration,
  reduceSessionGenerationRows,
  renderSessionGenerationHandoff,
  resolveSessionGenerationSettings,
  sessionGenerationAgeDays,
  sessionKeyGeneration,
  sessionKeyPrefix,
  withSessionGeneration,
  type SessionGenerationRunRow,
  type SessionGenerationState,
  type SessionGenerationStateQuery,
} from "./index.js";

const PREFIX = sessionKeyPrefix({ companyId: "company-a", agentId: "agent-a", issueId: "issue-a" });

function run(
  id: string,
  createdAt: string,
  sessionIdAfter: string | null,
  resultSummary: string | null = null,
): SessionGenerationRunRow {
  return { id, createdAt, sessionIdAfter, sessionIdBefore: null, resultSummary };
}

function emptyState(): SessionGenerationState {
  return { generation: 1, sessionKey: null, startedAt: null, messages: 0, latestRunId: null, latestRunSummary: null };
}

function state(overrides: Partial<SessionGenerationState>): SessionGenerationState {
  return { ...emptyState(), ...overrides };
}

describe("session key generations", () => {
  it("reads the generation of a key, and 1 for the unsuffixed vendor key", () => {
    expect(sessionKeyGeneration(`${PREFIX}`)).toBe(1);
    expect(sessionKeyGeneration(`${PREFIX}:g2`)).toBe(2);
    expect(sessionKeyGeneration(`${PREFIX}:g17`)).toBe(17);
    // A key from another task or another shape never reads as a generation.
    expect(sessionKeyGeneration("paperclip:company:company-a:agent:agent-a")).toBe(1);
  });

  it("writes the generation suffix, and drops it for the first generation", () => {
    expect(withSessionGeneration(PREFIX, 3)).toBe(`${PREFIX}:g3`);
    expect(withSessionGeneration(`${PREFIX}:g3`, 4)).toBe(`${PREFIX}:g4`);
    expect(withSessionGeneration(`${PREFIX}:g3`, 1)).toBe(PREFIX);
    expect(withSessionGeneration(PREFIX, Number.NaN)).toBe(PREFIX);
  });
});

describe("reduceSessionGenerationRows", () => {
  it("reports generation 1 with nothing behind it when the task has no run", () => {
    expect(reduceSessionGenerationRows({ rows: [], sessionKeyPrefix: PREFIX })).toEqual(emptyState());
  });

  it("counts the runs of the newest generation only, and dates it from its first run", () => {
    const rows = [
      run("r6", "2026-10-06T10:00:00.000Z", `${PREFIX}:g2`),
      run("r5", "2026-10-06T09:00:00.000Z", `${PREFIX}:g2`),
      run("r4", "2026-10-05T09:00:00.000Z", `${PREFIX}:g2`),
      run("r3", "2026-09-01T09:00:00.000Z", `${PREFIX}`),
      run("r2", "2026-08-31T09:00:00.000Z", `${PREFIX}`),
      run("r1", "2026-08-30T09:00:00.000Z", `${PREFIX}`),
    ];
    const reduced = reduceSessionGenerationRows({ rows, sessionKeyPrefix: PREFIX });
    expect(reduced.generation).toBe(2);
    expect(reduced.sessionKey).toBe(`${PREFIX}:g2`);
    expect(reduced.messages).toBe(3);
    expect(reduced.startedAt?.toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(reduced.latestRunId).toBe("r6");
  });

  it("ignores runs of another task, another strategy and another adapter", () => {
    const rows = [
      run("other-issue", "2026-10-06T10:00:00.000Z", sessionKeyPrefix({ companyId: "company-a", agentId: "agent-a", issueId: "issue-b" })),
      run("agent-scoped", "2026-10-06T09:00:00.000Z", "paperclip:company:company-a:agent:agent-a"),
      run("run-scoped", "2026-10-06T08:00:00.000Z", "paperclip:run:run-1"),
      run("no-session", "2026-10-06T07:00:00.000Z", null),
    ];
    expect(reduceSessionGenerationRows({ rows, sessionKeyPrefix: PREFIX })).toEqual(emptyState());
  });

  it("falls back to the before-session id of a run that never recorded one after it", () => {
    const rows: SessionGenerationRunRow[] = [
      { id: "r2", createdAt: "2026-10-06T10:00:00.000Z", sessionIdAfter: null, sessionIdBefore: `${PREFIX}:g2` },
      { id: "r1", createdAt: "2026-10-06T09:00:00.000Z", sessionIdAfter: null, sessionIdBefore: `${PREFIX}:g2` },
    ];
    const reduced = reduceSessionGenerationRows({ rows, sessionKeyPrefix: PREFIX });
    expect(reduced.generation).toBe(2);
    expect(reduced.messages).toBe(2);
  });

  it("keeps the newest run's summary for the handoff note", () => {
    const rows = [run("r2", "2026-10-06T10:00:00.000Z", `${PREFIX}:g2`, "did the last step")];
    expect(reduceSessionGenerationRows({ rows, sessionKeyPrefix: PREFIX }).latestRunSummary).toBe("did the last step");
  });
});

describe("decideSessionGeneration", () => {
  const thresholds = { enabled: true, maxMessages: 400, maxDays: 14 };
  const now = new Date("2026-10-06T12:00:00.000Z");

  it("continues the generation while it is inside both thresholds", () => {
    const decision = decideSessionGeneration({
      state: state({ generation: 1, messages: 400, startedAt: new Date("2026-09-30T12:00:00.000Z") }),
      thresholds,
      now,
    });
    expect(decision.rotate).toBe(false);
    expect(decision.generation).toBe(1);
    expect(decision.ageDays).toBeCloseTo(6, 5);
  });

  it("rolls over on activity: more messages than maxMessages", () => {
    const decision = decideSessionGeneration({
      state: state({ generation: 1, messages: 401, startedAt: new Date("2026-10-05T12:00:00.000Z") }),
      thresholds,
      now,
    });
    expect(decision.rotate).toBe(true);
    expect(decision.generation).toBe(2);
    expect(decision.reason).toContain("401 messages");
  });

  it("rolls over on age: older than maxDays, even with no activity", () => {
    const decision = decideSessionGeneration({
      state: state({ generation: 3, messages: 2, startedAt: new Date("2026-09-20T12:00:00.000Z") }),
      thresholds,
      now,
    });
    expect(decision.rotate).toBe(true);
    expect(decision.generation).toBe(4);
    expect(decision.reason).toContain("age reached 16 days");
  });

  it("rotates nothing when the feature is off, however far over the thresholds", () => {
    const decision = decideSessionGeneration({
      state: state({ generation: 2, messages: 9_999, startedAt: new Date("2020-01-01T00:00:00.000Z") }),
      thresholds: { ...thresholds, enabled: false },
      now,
    });
    expect(decision.rotate).toBe(false);
    expect(decision.generation).toBe(2);
  });

  it("never rotates the first generation of a task with no run recorded", () => {
    const decision = decideSessionGeneration({ state: emptyState(), thresholds, now });
    expect(decision.rotate).toBe(false);
    expect(decision.generation).toBe(1);
    expect(decision.ageDays).toBeNull();
  });

  it("measures the age in whole days from the generation's first run", () => {
    expect(sessionGenerationAgeDays(null, now)).toBeNull();
    expect(sessionGenerationAgeDays(new Date("2026-10-05T12:00:00.000Z"), now)).toBeCloseTo(1, 5);
  });
});

describe("resolveSessionGenerationSettings", () => {
  it("uses the plan's defaults with nothing stored and nothing in the environment", () => {
    expect(resolveSessionGenerationSettings({ stored: undefined, env: {} })).toEqual({
      enabled: true,
      maxMessages: 400,
      maxDays: 14,
    });
  });

  it("reads the instance settings, which win over the environment", () => {
    expect(
      resolveSessionGenerationSettings({
        stored: { maxMessages: 50, maxDays: 2 },
        env: { MYRMIDON_SESSION_GENERATIONS_MAX_MESSAGES: "900" },
      }),
    ).toEqual({ enabled: true, maxMessages: 50, maxDays: 2 });
  });

  it("falls back to the environment, and to the default for an unreadable value", () => {
    expect(
      resolveSessionGenerationSettings({
        stored: { maxMessages: "not a number" },
        env: { MYRMIDON_SESSION_GENERATIONS_MAX_MESSAGES: "900", MYRMIDON_SESSION_GENERATIONS_MAX_DAYS: "3" },
      }),
    ).toEqual({ enabled: true, maxMessages: 900, maxDays: 3 });
  });

  it("turns the feature off from the instance setting or the environment", () => {
    expect(resolveSessionGenerationSettings({ stored: { enabled: false }, env: {} }).enabled).toBe(false);
    expect(resolveSessionGenerationSettings({ stored: {}, env: { MYRMIDON_SESSION_GENERATIONS: "off" } }).enabled).toBe(false);
    // A typo must not silently disable the fix.
    expect(resolveSessionGenerationSettings({ stored: {}, env: { MYRMIDON_SESSION_GENERATIONS: "of" } }).enabled).toBe(true);
  });
});

describe("createSessionGenerationCache", () => {
  function makeReader() {
    return { readState: vi.fn(async () => state({ generation: 2, messages: 7 })) };
  }

  it("reads once inside the TTL and again after it, and never waits on a real clock", async () => {
    const reader = makeReader();
    let nowMs = 1_000;
    const cache = createSessionGenerationCache({ reader, ttlMs: 30_000, now: () => nowMs });
    const query: SessionGenerationStateQuery = { companyId: "company-a", agentId: "agent-a", issueId: "issue-a" };

    expect((await cache.read(query)).generation).toBe(2);
    expect((await cache.read(query)).generation).toBe(2);
    expect(reader.readState).toHaveBeenCalledTimes(1);

    nowMs += 30_001;
    await cache.read(query);
    expect(reader.readState).toHaveBeenCalledTimes(2);
  });

  it("keeps one entry per task, not per agent", async () => {
    const reader = { readState: vi.fn(async (query: SessionGenerationStateQuery) => state({ generation: query.issueId === "issue-a" ? 2 : 1 })) };
    const cache = createSessionGenerationCache({ reader, ttlMs: 30_000, now: () => 0 });
    await cache.read({ companyId: "company-a", agentId: "agent-a", issueId: "issue-a" });
    await cache.read({ companyId: "company-a", agentId: "agent-a", issueId: "issue-b" });
    await cache.read({ companyId: "company-a", agentId: "agent-a", issueId: "issue-a" });
    expect(cache.size()).toBe(2);
    expect(reader.readState).toHaveBeenCalledTimes(2);
  });

  it("drops the oldest entry past its bound", async () => {
    const reader = { readState: vi.fn(async () => emptyState()) };
    let nowMs = 0;
    const cache = createSessionGenerationCache({ reader, ttlMs: 1_000, maxEntries: 1, now: () => nowMs });
    await cache.read({ companyId: "company-a", agentId: "agent-a", issueId: "issue-a" });
    nowMs += 10;
    await cache.read({ companyId: "company-a", agentId: "agent-a", issueId: "issue-b" });
    expect(cache.size()).toBe(1);
  });
});

describe("createSessionGenerationResolver", () => {
  const now = new Date("2026-10-06T12:00:00.000Z");

  function makeResolver(stateValue: SessionGenerationState, settings = { enabled: true, maxMessages: 400, maxDays: 14 }) {
    const readState = vi.fn(async () => stateValue);
    const resolver = createSessionGenerationResolver({
      reader: createSessionGenerationCache({ reader: { readState }, ttlMs: 0, now: () => now.getTime() }),
      readSettings: async () => settings,
      now: () => now,
    });
    return { resolver, readState };
  }

  const base = {
    companyId: "company-a",
    agentId: "agent-a",
    adapterType: "hermes_gateway",
    sessionKeyStrategy: "issue",
    issueId: "issue-a",
  };

  it("asks for the next generation when the activity threshold is crossed", async () => {
    const { resolver } = makeResolver(state({ generation: 1, messages: 401, sessionKey: PREFIX }));
    const result = await resolver.resolve(base);
    expect(result?.rotate).toBe(true);
    expect(result?.generation).toBe(2);
    expect(result?.previousSessionKey).toBe(PREFIX);
    expect(result?.handoffMarkdown).toContain("session generation g2");
  });

  it("asks for the next generation when the age threshold is crossed", async () => {
    const { resolver } = makeResolver(
      state({ generation: 2, messages: 3, sessionKey: `${PREFIX}:g2`, startedAt: new Date("2026-09-01T12:00:00.000Z") }),
    );
    const result = await resolver.resolve(base);
    expect(result?.rotate).toBe(true);
    expect(result?.generation).toBe(3);
    expect(result?.ageDays).toBeCloseTo(35, 0);
  });

  it("keeps the generation while it is inside its thresholds", async () => {
    const { resolver } = makeResolver(
      state({ generation: 2, messages: 40, sessionKey: `${PREFIX}:g2`, startedAt: new Date("2026-10-04T12:00:00.000Z") }),
    );
    const result = await resolver.resolve(base);
    expect(result).toMatchObject({ generation: 2, rotate: false, reason: null, handoffMarkdown: null });
  });

  it("reports the first generation, unsuffixed, for a task with no run", async () => {
    const { resolver } = makeResolver(emptyState());
    expect(await resolver.resolve(base)).toMatchObject({ generation: 1, rotate: false });
  });

  it("touches nothing for another adapter, another strategy or a wake without a task", async () => {
    const { resolver, readState } = makeResolver(state({ generation: 1, messages: 999 }));
    expect(await resolver.resolve({ ...base, adapterType: "hermes_local" })).toBeNull();
    expect(await resolver.resolve({ ...base, adapterType: null })).toBeNull();
    expect(await resolver.resolve({ ...base, sessionKeyStrategy: "agent" })).toBeNull();
    expect(await resolver.resolve({ ...base, sessionKeyStrategy: "run" })).toBeNull();
    expect(await resolver.resolve({ ...base, sessionKeyStrategy: "none" })).toBeNull();
    expect(await resolver.resolve({ ...base, issueId: null })).toBeNull();
    expect(await resolver.resolve({ ...base, issueId: "  " })).toBeNull();
    // Not one query for a run the feature does not own.
    expect(readState).not.toHaveBeenCalled();
  });

  it("treats an absent strategy as the issue default", async () => {
    const { resolver } = makeResolver(state({ generation: 1, messages: 401, sessionKey: PREFIX }));
    expect((await resolver.resolve({ ...base, sessionKeyStrategy: null }))?.rotate).toBe(true);
  });

  it("touches nothing while the feature is switched off", async () => {
    const { resolver, readState } = makeResolver(state({ generation: 1, messages: 5_000 }), {
      enabled: false,
      maxMessages: 400,
      maxDays: 14,
    });
    expect(await resolver.resolve(base)).toBeNull();
    expect(readState).not.toHaveBeenCalled();
  });

  it("reads one more row than the activity threshold asks for", async () => {
    const { resolver, readState } = makeResolver(emptyState(), { enabled: true, maxMessages: 5_000, maxDays: 14 });
    await resolver.resolve(base);
    expect(readState).toHaveBeenCalledWith(expect.objectContaining({ scanLimit: 5_001 }));
  });
});

describe("renderSessionGenerationHandoff", () => {
  it("names the generation, the reason and the last run's summary", () => {
    const note = renderSessionGenerationHandoff({
      previousSessionKey: PREFIX,
      issueId: "issue-a",
      generation: 2,
      reason: "session generation reached 401 messages (threshold 400)",
      messages: 401,
      latestRunSummary: "finished the previous step",
      continuationSummary: "the task continues",
    });
    expect(note).toContain("- Previous session: paperclip:company:company-a:agent:agent-a:issue:issue-a");
    expect(note).toContain("- Rotation reason: session generation reached 401 messages (threshold 400)");
    expect(note).toContain("- Messages in the previous generation: 401");
    expect(note).toContain("- Last run summary: finished the previous step");
    expect(note).toContain("- Issue continuation summary: the task continues");
    expect(note).toContain("session generation g2");
  });

  it("stays a note even with nothing to summarise", () => {
    const note = renderSessionGenerationHandoff({
      previousSessionKey: null,
      issueId: "issue-a",
      generation: 2,
      reason: "session generation age reached 15 days (threshold 14)",
      messages: 0,
      latestRunSummary: null,
    });
    expect(note).not.toContain("Previous session");
    expect(note).not.toContain("Last run summary");
    expect(note.split("\n").every((line) => line.length > 0)).toBe(true);
  });
});