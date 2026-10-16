// myrmidon(1.2-COST-CACHING): idle-skip metrics and the prompt cache by cost.
//
// Part A pins the settings parser, the counter step and the log line of the
// idle-skip measurement (MYRMIDON_IDLE_SKIP_METRICS, off by default).
//
// Part B pins the prompt cache (MYRMIDON_PROMPT_CACHE_MIN_COST, unset = off):
// the fingerprint treats two wakes with the same context snapshot as
// identical, and the lookup reuses the agent's previous finished run's
// recorded answer ONLY when the snapshots match AND the recorded cost meets
// the threshold. A different snapshot, a cost below the threshold, a failed
// run, or another agent's run never reuse anything.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  fingerprintWakeContext,
  findReusablePromptAnswer,
  getIdleSkipMetrics,
  idleSkipMetricsEnabled,
  readPromptCacheSettings,
  recordIdleSkip,
  resetIdleSkipMetrics,
} from "./cost-caching.js";

describe("idle-skip metrics settings (1.2-COST-CACHING A)", () => {
  it("is off by default and on only for an explicit affirmative value", () => {
    expect(idleSkipMetricsEnabled({})).toBe(false);
    expect(idleSkipMetricsEnabled({ MYRMIDON_IDLE_SKIP_METRICS: "0" })).toBe(false);
    expect(idleSkipMetricsEnabled({ MYRMIDON_IDLE_SKIP_METRICS: "off" })).toBe(false);
    expect(idleSkipMetricsEnabled({ MYRMIDON_IDLE_SKIP_METRICS: "1" })).toBe(true);
    expect(idleSkipMetricsEnabled({ MYRMIDON_IDLE_SKIP_METRICS: "true" })).toBe(true);
    expect(idleSkipMetricsEnabled({ MYRMIDON_IDLE_SKIP_METRICS: "YES" })).toBe(true);
    expect(idleSkipMetricsEnabled({ MYRMIDON_IDLE_SKIP_METRICS: " on " })).toBe(true);
  });

  it("prompt cache is off unless the threshold is a positive finite number", () => {
    expect(readPromptCacheSettings({})).toEqual({ enabled: false, minCostUsd: 0 });
    expect(readPromptCacheSettings({ MYRMIDON_PROMPT_CACHE_MIN_COST: "0" }).enabled).toBe(false);
    expect(readPromptCacheSettings({ MYRMIDON_PROMPT_CACHE_MIN_COST: "-1" }).enabled).toBe(false);
    expect(readPromptCacheSettings({ MYRMIDON_PROMPT_CACHE_MIN_COST: "abc" }).enabled).toBe(false);
    expect(readPromptCacheSettings({ MYRMIDON_PROMPT_CACHE_MIN_COST: "0.5" })).toEqual({
      enabled: true,
      minCostUsd: 0.5,
    });
  });
});

describe("idle-skip metrics counters (1.2-COST-CACHING A)", () => {
  afterEach(() => {
    resetIdleSkipMetrics();
  });

  it("each recorded skip bumps the skipped-wake and saved-call counters", () => {
    resetIdleSkipMetrics();
    expect(getIdleSkipMetrics()).toEqual({
      skippedIdleWakes: 0,
      savedModelCalls: 0,
      lastSkipAt: null,
    });
    recordIdleSkip(
      { companyId: "company-a", agentId: "agent-a" },
      { now: new Date("2026-10-07T12:00:00.000Z") },
    );
    recordIdleSkip(
      { companyId: "company-a", agentId: "agent-b" },
      { now: new Date("2026-10-07T12:05:00.000Z") },
    );
    const snapshot = getIdleSkipMetrics();
    expect(snapshot.skippedIdleWakes).toBe(2);
    expect(snapshot.savedModelCalls).toBe(2);
    expect(snapshot.lastSkipAt).toBe("2026-10-07T12:05:00.000Z");
  });
});

describe("wake-context fingerprint (1.2-COST-CACHING B)", () => {
  it("identical snapshots fingerprint identically regardless of key order", () => {
    const a = fingerprintWakeContext({ source: "timer", nested: { b: 2, a: 1 } });
    const b = fingerprintWakeContext({ nested: { a: 1, b: 2 }, source: "timer" });
    expect(a).toBe(b);
  });

  it("volatile wake/run ids and the tick timestamp do not change the fingerprint", () => {
    const a = fingerprintWakeContext({ source: "timer", runId: "run-1", now: "2026-10-07T12:00:00.000Z" });
    const b = fingerprintWakeContext({ source: "timer", runId: "run-2", requestId: "req-9", now: "2026-10-07T12:05:00.000Z" });
    expect(a).toBe(b);
  });

  it("a different prompt payload fingerprints differently", () => {
    const a = fingerprintWakeContext({ source: "timer", issueId: null });
    const b = fingerprintWakeContext({ source: "timer", issueId: "issue-1" });
    expect(a).not.toBe(b);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("prompt cache lookup (1.2-COST-CACHING B)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cost-caching-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  const TIMER_SNAPSHOT = { source: "timer", triggerDetail: "heartbeat_timer" };

  async function insertFinishedRun(
    agentId: string,
    companyId: string,
    overrides: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      agentId,
      companyId,
      invocationSource: "timer",
      status: "succeeded",
      startedAt: new Date("2026-10-07T11:00:00.000Z"),
      finishedAt: new Date("2026-10-07T11:05:00.000Z"),
      contextSnapshot: { ...TIMER_SNAPSHOT, runId: id },
      usageJson: { costUsd: 0.75, provider: "example", model: "model-a" },
      resultJson: { summary: "nothing to do" },
      ...overrides,
    });
    return id;
  }

  it("reuses the answer when the snapshot is identical and the cost meets the threshold", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await insertFinishedRun(agentId, companyId);
    const fingerprint = fingerprintWakeContext(TIMER_SNAPSHOT);
    const cached = await findReusablePromptAnswer(db, {
      agentId,
      companyId,
      fingerprint,
      minCostUsd: 0.5,
    });
    expect(cached).not.toBeNull();
    expect(cached?.runId).toBe(runId);
    expect(cached?.costUsd).toBe(0.75);
    expect(cached?.summary).toBe("nothing to do");
  });

  it("does not reuse when the recorded cost is below the threshold", async () => {
    const { companyId, agentId } = await seedAgent();
    await insertFinishedRun(agentId, companyId, {
      usageJson: { costUsd: 0.01 },
    });
    const fingerprint = fingerprintWakeContext(TIMER_SNAPSHOT);
    const cached = await findReusablePromptAnswer(db, {
      agentId,
      companyId,
      fingerprint,
      minCostUsd: 0.5,
    });
    expect(cached).toBeNull();
  });

  it("does not reuse when the snapshot differs (the prompt is not identical)", async () => {
    const { companyId, agentId } = await seedAgent();
    await insertFinishedRun(agentId, companyId, {
      contextSnapshot: { source: "timer", triggerDetail: "heartbeat_timer", issueId: "issue-1" },
    });
    const fingerprint = fingerprintWakeContext(TIMER_SNAPSHOT);
    const cached = await findReusablePromptAnswer(db, {
      agentId,
      companyId,
      fingerprint,
      minCostUsd: 0.5,
    });
    expect(cached).toBeNull();
  });

  it("does not reuse a failed run or another agent's run", async () => {
    const { companyId, agentId } = await seedAgent();
    await insertFinishedRun(agentId, companyId, { status: "failed" });
    const fingerprint = fingerprintWakeContext(TIMER_SNAPSHOT);
    expect(
      await findReusablePromptAnswer(db, {
        agentId,
        companyId,
        fingerprint,
        minCostUsd: 0.5,
      }),
    ).toBeNull();
    expect(
      await findReusablePromptAnswer(db, {
        agentId: randomUUID(),
        companyId,
        fingerprint,
        minCostUsd: 0.5,
      }),
    ).toBeNull();
  });

  it("does not reuse a run without recorded cost even when the snapshot matches", async () => {
    const { companyId, agentId } = await seedAgent();
    await insertFinishedRun(agentId, companyId, { usageJson: null });
    const fingerprint = fingerprintWakeContext(TIMER_SNAPSHOT);
    const cached = await findReusablePromptAnswer(db, {
      agentId,
      companyId,
      fingerprint,
      minCostUsd: 0.5,
    });
    expect(cached).toBeNull();
  });
});
