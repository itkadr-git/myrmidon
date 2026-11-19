import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { attentionService } from "../services/attention.js";
import { logActivity } from "../services/activity-log.js";
import {
  AUTO_RESUME_ACTIVITY_ACTION,
  AUTO_RESUME_CONTAINER_START_FAILED_ACTIVITY_ACTION,
  AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION,
  AUTO_RESUME_INTERVAL_SEC_ENV,
  AUTO_RESUME_METADATA_KEY,
  autoResumeMetrics,
  countAutoResumeExhaustionsSince,
  countAutoResumesSince,
  createAutoResumeSweeper,
  readAutoResumeState,
} from "../myrmidon/auto-resume.js";

// AUTO-RESUME (1.4): the sweep brings an agent left in `error` back with the
// 1/5/15 min backoff and, after the attempt cap, stops and escalates the
// existing `agent_error_alert` card to the operator.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BASE = Date.parse("2026-10-02T00:00:00.000Z");
const MINUTE = 60_000;

describeEmbeddedPostgres("auto-resume sweep (AUTO-RESUME)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-auto-resume-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: {
    status?: string;
    updatedAt?: Date;
    metadata?: Record<string, unknown> | null;
    errorReason?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: input.status ?? "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      errorReason: input.errorReason ?? "gateway 500",
      metadata: input.metadata ?? null,
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    });
    return { companyId, agentId };
  }

  async function agentRow(agentId: string) {
    return (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  }

  async function failAgain(agentId: string, updatedAt: Date) {
    await db.update(agents).set({ status: "error", updatedAt }).where(eq(agents.id, agentId));
  }

  // OPE-11947: an agent the module already gave up on (exhaustedAt = BASE + 1 min).
  function exhaustedMetadata() {
    return {
      [AUTO_RESUME_METADATA_KEY]: {
        failures: 3,
        lastFailureAt: new Date(BASE).toISOString(),
        nextAttemptAt: null,
        exhaustedAt: new Date(BASE + MINUTE).toISOString(),
        lastResumeAt: new Date(BASE).toISOString(),
      },
    };
  }

  /** One activity row about an agent, as `routes/agents.ts` (user) or the system writes it. */
  async function logAgentAction(input: {
    companyId: string;
    entityAgentId: string;
    action: string;
    actorType: "user" | "system";
    createdAt: Date;
  }) {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: input.actorType,
      actorId: input.actorType === "user" ? "board-user" : "heartbeat",
      action: input.action,
      entityType: "agent",
      entityId: input.entityAgentId,
      createdAt: input.createdAt,
    });
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    createdAt: Date;
    finishedAt?: Date | null;
    resultJson?: Record<string, unknown> | null;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      createdAt: input.createdAt,
      finishedAt: input.finishedAt ?? null,
      resultJson: input.resultJson ?? null,
    });
  }

  function makeSweeper(deps: {
    resumeWake?: ReturnType<typeof vi.fn>;
    invokable?: boolean;
    maintenance?: boolean;
    startContainer?: ReturnType<typeof vi.fn>;
  } = {}) {
    const resumeWake = deps.resumeWake ?? vi.fn(async () => ({}));
    const sweeper = createAutoResumeSweeper({
      db,
      resumeWake: resumeWake as unknown as (agentId: string) => Promise<unknown>,
      isAgentInvokable: async () => deps.invokable ?? true,
      isAgentUnderMaintenance: async () => deps.maintenance ?? false,
      ...(deps.startContainer
        ? { startContainer: deps.startContainer as unknown as (agentId: string) => Promise<void> }
        : {}),
      logActivity: async (input) => {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId,
          runId: input.runId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          details: input.details,
        });
      },
      env: { [AUTO_RESUME_INTERVAL_SEC_ENV]: "10" } as NodeJS.ProcessEnv,
    });
    const sweepAt = (offsetMs: number) => {
      // Bypass the per-minute gate so each step is explicit in the test.
      sweeper.resetForTest();
      return sweeper.sweep(new Date(BASE + offsetMs));
    };
    return { sweeper, resumeWake, sweepAt };
  }

  it("resumes an errored agent on the 1/5/15 min backoff, then gives up", async () => {
    const { companyId, agentId } = await seedAgent({ updatedAt: new Date(BASE) });
    const { resumeWake, sweepAt } = makeSweeper();

    // Not due yet: the first step is one minute after the error entry.
    const before = await sweepAt(59_000);
    expect(before.resumed).toBe(0);
    expect(before.agentIds).toEqual([]);
    expect(resumeWake).not.toHaveBeenCalled();
    expect((await agentRow(agentId)).status).toBe("error");

    // First attempt at +1 min: the agent goes idle and the wake chain runs.
    const first = await sweepAt(MINUTE);
    expect(first.resumed).toBe(1);
    expect(first.agentIds).toEqual([agentId]);
    expect(resumeWake).toHaveBeenCalledTimes(1);
    let row = await agentRow(agentId);
    expect(row.status).toBe("idle");
    expect(row.errorReason).toBeNull();
    expect(readAutoResumeState(row.metadata)?.failures).toBe(1);

    // The run fails again: same streak, next step is 5 min after the resume.
    await failAgain(agentId, new Date(BASE + MINUTE));
    const tooSoon = await sweepAt(MINUTE + 4 * MINUTE);
    expect(tooSoon.resumed).toBe(0);
    const second = await sweepAt(MINUTE + 5 * MINUTE);
    expect(second.resumed).toBe(1);
    expect(resumeWake).toHaveBeenCalledTimes(2);

    // Second failure → third attempt 15 min later.
    await failAgain(agentId, new Date(BASE + MINUTE + 5 * MINUTE));
    const thirdAt = MINUTE + 5 * MINUTE + 15 * MINUTE;
    const third = await sweepAt(thirdAt);
    expect(third.resumed).toBe(1);
    expect(resumeWake).toHaveBeenCalledTimes(3);

    // Third failure → the cap is reached: the agent stays in error and the
    // board stops; no fourth resume.
    await failAgain(agentId, new Date(thirdAt));
    const exhausted = await sweepAt(thirdAt + 1_000);
    expect(exhausted.exhausted).toBe(1);
    expect(exhausted.resumed).toBe(0);
    expect(resumeWake).toHaveBeenCalledTimes(3);
    row = await agentRow(agentId);
    expect(row.status).toBe("error");
    expect(readAutoResumeState(row.metadata)?.exhaustedAt).toBeTruthy();

    // Still given up on later ticks.
    const later = await sweepAt(BASE + 24 * 60 * MINUTE);
    expect(later.resumed).toBe(0);
    expect(later.exhausted).toBe(0);
    expect(resumeWake).toHaveBeenCalledTimes(3);

    // Activity log: three resumes and one give-up, and the 24 h metric reads them.
    const since = new Date(0);
    expect(await countAutoResumesSince(db, companyId, since)).toBe(3);
    expect(await countAutoResumeExhaustionsSince(db, companyId, since)).toBe(1);
    expect(await autoResumeMetrics(db, companyId, since)).toEqual({ autoResumes: 3, exhaustions: 1 });

    // The attention card escalates to the operator once the board gave up.
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const card = feed.items.find((item) => item.sourceKind === "agent_error_alert");
    expect(card).toBeTruthy();
    expect(card?.whyNow).toContain("Automatic resume gave up");
    expect(card?.severity).toBe("critical");
    expect(card?.subject.metadata?.autoResumeExhausted).toBe(true);
    expect(card?.subject.metadata?.autoResumeAttempts).toBe(3);
  });

  it("keeps the plain card before the first backoff step", async () => {
    const { companyId } = await seedAgent({ updatedAt: new Date(BASE) });
    const { sweepAt } = makeSweeper();

    // Not due yet: the agent stays in `error`, so the desk still shows the
    // vendor wording until the board gives up.
    const result = await sweepAt(30_000);
    expect(result.resumed).toBe(0);
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const card = feed.items.find((item) => item.sourceKind === "agent_error_alert");
    expect(card).toBeTruthy();
    expect(card?.whyNow).toBe("Agent is in error status and needs operator action or dismissal.");
    expect(card?.severity).toBe("high");
    expect(card?.subject.metadata?.autoResumeExhausted).toBeUndefined();
  });

  it("re-arms after an operator resumes the agent following a give-up", async () => {
    const { companyId, agentId } = await seedAgent({
      updatedAt: new Date(BASE),
      metadata: exhaustedMetadata(),
    });
    const { resumeWake, sweepAt } = makeSweeper();

    // A user's resume after the give-up: a new episode, resume again.
    await failAgain(agentId, new Date(BASE + 60 * MINUTE));
    await logAgentAction({
      companyId,
      entityAgentId: agentId,
      action: "agent.resumed",
      actorType: "user",
      createdAt: new Date(BASE + 60 * MINUTE),
    });
    const result = await sweepAt(61 * MINUTE);
    expect(result.resumed).toBe(1);
    expect(resumeWake).toHaveBeenCalledTimes(1);
    const row = await agentRow(agentId);
    expect(readAutoResumeState(row.metadata)?.failures).toBe(1);
    expect(readAutoResumeState(row.metadata)?.exhaustedAt).toBeNull();
  });

  it("does not re-arm a give-up when only agents.updated_at moved (OPE-11947)", async () => {
    const { companyId, agentId } = await seedAgent({
      updatedAt: new Date(BASE),
      metadata: exhaustedMetadata(),
    });
    const otherAgent = await seedAgent({ status: "idle", updatedAt: new Date(BASE) });
    const { resumeWake, sweepAt } = makeSweeper();

    // Seen in production: given up, then back to attempt 1 three minutes later
    // because a run moved updated_at. Runs, status changes and system updates
    // are not operators.
    await failAgain(agentId, new Date(BASE + 5 * MINUTE));
    await logAgentAction({
      companyId,
      entityAgentId: agentId,
      action: "agent.updated",
      actorType: "system",
      createdAt: new Date(BASE + 5 * MINUTE),
    });
    // A user's action before the give-up, and one on another agent, do not count either.
    await logAgentAction({
      companyId,
      entityAgentId: agentId,
      action: "agent.resumed",
      actorType: "user",
      createdAt: new Date(BASE),
    });
    await logAgentAction({
      companyId: otherAgent.companyId,
      entityAgentId: otherAgent.agentId,
      action: "agent.resumed",
      actorType: "user",
      createdAt: new Date(BASE + 10 * MINUTE),
    });

    for (const offset of [6 * MINUTE, 20 * MINUTE, 60 * MINUTE]) {
      const result = await sweepAt(offset);
      expect(result.resumed).toBe(0);
      expect(result.exhausted).toBe(0);
    }
    expect(resumeWake).not.toHaveBeenCalled();
    const row = await agentRow(agentId);
    expect(row.status).toBe("error");
    expect(readAutoResumeState(row.metadata)?.exhaustedAt).toBe(new Date(BASE + MINUTE).toISOString());
    expect(readAutoResumeState(row.metadata)?.failures).toBe(3);

    // A user updating the agent after the give-up does re-arm it.
    await logAgentAction({
      companyId,
      entityAgentId: agentId,
      action: "agent.updated",
      actorType: "user",
      createdAt: new Date(BASE + 70 * MINUTE),
    });
    await failAgain(agentId, new Date(BASE + 70 * MINUTE));
    const rearmed = await sweepAt(72 * MINUTE);
    expect(rearmed.agentIds).toContain(agentId);
    expect(readAutoResumeState((await agentRow(agentId)).metadata)?.exhaustedAt).toBeNull();
  });

  it("brings a model-unavailable agent back on the long schedule, outside the attempt cap (OPE-11947)", async () => {
    const { companyId, agentId } = await seedAgent({ updatedAt: new Date(BASE) });
    const { resumeWake, sweepAt } = makeSweeper();

    // The model pool ran out of quota: the last finished run carries the marker.
    await seedRun({
      companyId,
      agentId,
      status: "failed",
      createdAt: new Date(BASE - 5 * MINUTE),
      finishedAt: new Date(BASE - 4 * MINUTE),
      resultJson: { provider_error_as_content: true, model_unavailable: true },
    });
    // Its own retry waits in scheduled_retry (not finished): still the same verdict.
    await seedRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      createdAt: new Date(BASE - 3 * MINUTE),
    });

    // 30 min after that run ended (BASE + 26 min) is the first step; the 1/5/15 min backoff does not apply.
    for (const offset of [10 * MINUTE, 25 * MINUTE]) {
      const waiting = await sweepAt(offset);
      expect(waiting.resumed).toBe(0);
      expect(waiting.skipped).toBe(1);
    }
    expect(resumeWake).not.toHaveBeenCalled();
    expect((await agentRow(agentId)).status).toBe("error");
    expect(readAutoResumeState((await agentRow(agentId)).metadata)).toBeNull();

    const first = await sweepAt(26 * MINUTE);
    expect(first.agentIds).toEqual([agentId]);
    expect(resumeWake).toHaveBeenCalledTimes(1);
    let row = await agentRow(agentId);
    expect(row.status).toBe("idle");
    expect(readAutoResumeState(row.metadata)).toMatchObject({
      failures: 0,
      exhaustedAt: null,
      modelUnavailableResumes: 1,
    });
    const issued = (await db.select().from(activityLog)).filter((entry) => entry.action === AUTO_RESUME_ACTIVITY_ACTION);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.details).toMatchObject({ modelUnavailable: true, modelUnavailableResumes: 1 });

    // The resumed agent fails on the same quota: the next step is one hour after that run ended.
    await seedRun({
      companyId,
      agentId,
      status: "failed",
      createdAt: new Date(BASE + 27 * MINUTE),
      finishedAt: new Date(BASE + 28 * MINUTE),
      resultJson: { provider_error_as_content: true, model_unavailable: true },
    });
    await failAgain(agentId, new Date(BASE + 28 * MINUTE));
    expect((await sweepAt(28 * MINUTE + 59 * MINUTE)).resumed).toBe(0);
    expect((await sweepAt(28 * MINUTE + 60 * MINUTE)).agentIds).toEqual([agentId]);
    row = await agentRow(agentId);
    expect(readAutoResumeState(row.metadata)).toMatchObject({ failures: 0, modelUnavailableResumes: 2 });
    expect(resumeWake).toHaveBeenCalledTimes(2);

    // A later failure of another kind ends the series: the ordinary backoff and its cap apply again.
    await seedRun({
      companyId,
      agentId,
      status: "failed",
      createdAt: new Date(BASE + 89 * MINUTE),
      finishedAt: new Date(BASE + 90 * MINUTE),
      resultJson: { errorFamily: "transient_upstream" },
    });
    await failAgain(agentId, new Date(BASE + 90 * MINUTE));
    const ordinary = await sweepAt(91 * MINUTE);
    expect(ordinary.agentIds).toEqual([agentId]);
    const state = readAutoResumeState((await agentRow(agentId)).metadata);
    expect(state?.failures).toBe(1);
    expect(state?.modelUnavailableResumes).toBeUndefined();
  });

  it("does not leave a given-up agent in error once its last run is model-unavailable (OPE-11947)", async () => {
    const { companyId, agentId } = await seedAgent({
      updatedAt: new Date(BASE),
      metadata: exhaustedMetadata(),
    });
    const { resumeWake, sweepAt } = makeSweeper();
    await seedRun({
      companyId,
      agentId,
      status: "failed",
      createdAt: new Date(BASE - 5 * MINUTE),
      finishedAt: new Date(BASE - 4 * MINUTE),
      resultJson: { provider_error_as_content: true, model_unavailable: true },
    });

    // An earlier give-up does not hold the agent back from the long schedule.
    expect((await sweepAt(25 * MINUTE)).resumed).toBe(0);
    const resumed = await sweepAt(26 * MINUTE);
    expect(resumed.exhausted).toBe(0);
    expect(resumed.agentIds).toEqual([agentId]);
    expect(resumeWake).toHaveBeenCalledTimes(1);
    expect(readAutoResumeState((await agentRow(agentId)).metadata)).toMatchObject({
      failures: 0,
      exhaustedAt: null,
      modelUnavailableResumes: 1,
    });
  });

  it("does not resume a non-invokable agent or one under maintenance", async () => {
    await seedAgent({ updatedAt: new Date(BASE) });
    await seedAgent({ updatedAt: new Date(BASE) });
    const resumeWake = vi.fn(async () => ({}));

    const paused = createAutoResumeSweeper({
      db,
      resumeWake: resumeWake as unknown as (agentId: string) => Promise<unknown>,
      isAgentInvokable: async () => false,
      isAgentUnderMaintenance: async () => false,
      env: { [AUTO_RESUME_INTERVAL_SEC_ENV]: "10" } as NodeJS.ProcessEnv,
    });
    paused.resetForTest();
    const pausedResult = await paused.sweep(new Date(BASE + 10 * MINUTE));
    expect(pausedResult.resumed).toBe(0);
    expect(pausedResult.skipped).toBe(2);
    expect(resumeWake).not.toHaveBeenCalled();

    const maintenance = createAutoResumeSweeper({
      db,
      resumeWake: resumeWake as unknown as (agentId: string) => Promise<unknown>,
      isAgentInvokable: async () => true,
      isAgentUnderMaintenance: async () => true,
      env: { [AUTO_RESUME_INTERVAL_SEC_ENV]: "10" } as NodeJS.ProcessEnv,
    });
    maintenance.resetForTest();
    const maintenanceResult = await maintenance.sweep(new Date(BASE + 10 * MINUTE));
    expect(maintenanceResult.resumed).toBe(0);
    expect(maintenanceResult.skipped).toBe(2);
    expect(resumeWake).not.toHaveBeenCalled();
  });

  it("records the automatic action in the activity log", async () => {
    const { companyId } = await seedAgent({ updatedAt: new Date(BASE) });
    const { sweepAt } = makeSweeper();
    await sweepAt(MINUTE);
    const rows = await db.select().from(activityLog);
    expect(rows.map((row) => row.action)).toContain(AUTO_RESUME_ACTIVITY_ACTION);
    expect(rows.some((row) => row.companyId === companyId && row.action === AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION)).toBe(false);
  });

  // 1.6.6: 07.11 an idle-stopped container left adm-devops in `error` with the reason
  // "контейнер не поднят" for 4.5 h, because the sweep skipped that reason.
  describe("agent left in 'контейнер не поднят'", () => {
    const CONTAINER_REASON = "контейнер не поднят";

    it("starts the bot container, then resumes the agent", async () => {
      const { companyId, agentId } = await seedAgent({ updatedAt: new Date(BASE), errorReason: CONTAINER_REASON });
      const startContainer = vi.fn(async () => undefined);
      const { resumeWake, sweepAt } = makeSweeper({ startContainer });

      const result = await sweepAt(0);

      expect(startContainer).toHaveBeenCalledTimes(1);
      expect(startContainer).toHaveBeenCalledWith(agentId);
      expect(result.resumed).toBe(1);
      expect(result.agentIds).toEqual([agentId]);
      expect(resumeWake).toHaveBeenCalledTimes(1);
      // The container is up before the wake chain runs.
      expect(startContainer.mock.invocationCallOrder[0]).toBeLessThan(resumeWake.mock.invocationCallOrder[0]!);
      const row = await agentRow(agentId);
      expect(row.status).toBe("idle");
      expect(row.errorReason).toBeNull();
      // A healthy start is an ordinary resume: it counts in the ordinary streak, and the
      // start-attempt marks are gone.
      const state = readAutoResumeState(row.metadata);
      expect(state?.failures).toBe(1);
      expect(state?.exhaustedAt).toBeNull();
      expect(state?.containerStartFailures).toBeUndefined();
      const issued = (await db.select().from(activityLog)).filter(
        (item) => item.companyId === companyId && item.action === AUTO_RESUME_ACTIVITY_ACTION,
      );
      expect(issued).toHaveLength(1);
      expect(issued[0]?.details).toMatchObject({ containerStarted: true, errorReason: CONTAINER_REASON });
    });

    it("retries a start that failed every 15 minutes, 4 attempts, then one operator card and no more", async () => {
      const { companyId, agentId } = await seedAgent({ updatedAt: new Date(BASE), errorReason: CONTAINER_REASON });
      const startContainer = vi.fn(async () => {
        throw new Error("docker start: no such container");
      });
      const { resumeWake, sweepAt } = makeSweeper({ startContainer });

      // Attempt 1 at once; the agent stays in error with the reason intact.
      const first = await sweepAt(0);
      expect(first.resumed).toBe(0);
      expect(startContainer).toHaveBeenCalledTimes(1);
      let row = await agentRow(agentId);
      expect(row.status).toBe("error");
      expect(row.errorReason).toBe(CONTAINER_REASON);
      expect(readAutoResumeState(row.metadata)?.containerStartFailures).toBe(1);

      // Not before 15 minutes after the attempt, whatever the tick rate.
      await sweepAt(MINUTE);
      await sweepAt(14 * MINUTE + 59_000);
      expect(startContainer).toHaveBeenCalledTimes(1);

      await sweepAt(15 * MINUTE);
      expect(startContainer).toHaveBeenCalledTimes(2);
      await sweepAt(30 * MINUTE);
      expect(startContainer).toHaveBeenCalledTimes(3);
      const fourth = await sweepAt(45 * MINUTE);
      expect(startContainer).toHaveBeenCalledTimes(4);
      // The cap is reached but the alarm comes on the next pass, not as part of the attempt.
      expect(fourth.exhausted).toBe(0);
      expect(readAutoResumeState((await agentRow(agentId)).metadata)?.exhaustedAt ?? null).toBeNull();

      // Give-up: the operator card, no fifth start, no resume.
      const gaveUp = await sweepAt(46 * MINUTE);
      expect(gaveUp.exhausted).toBe(1);
      expect(gaveUp.resumed).toBe(0);
      expect(startContainer).toHaveBeenCalledTimes(4);
      row = await agentRow(agentId);
      expect(row.status).toBe("error");
      expect(readAutoResumeState(row.metadata)?.exhaustedAt).toBeTruthy();

      // And it stays given up: one alarm, not one per tick.
      const later = await sweepAt(24 * 60 * MINUTE);
      expect(later.exhausted).toBe(0);
      expect(later.resumed).toBe(0);
      expect(startContainer).toHaveBeenCalledTimes(4);
      expect(resumeWake).not.toHaveBeenCalled();

      const actions = (await db.select().from(activityLog))
        .filter((item) => item.companyId === companyId)
        .map((item) => item.action);
      expect(actions.filter((action) => action === AUTO_RESUME_CONTAINER_START_FAILED_ACTIVITY_ACTION)).toHaveLength(4);
      expect(actions.filter((action) => action === AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION)).toHaveLength(1);
      expect(actions).not.toContain(AUTO_RESUME_ACTIVITY_ACTION);

      // The alarm is the existing one: the critical `agent_error_alert` card.
      const feed = await attentionService(db).list(companyId, { userId: "board-user" });
      const card = feed.items.find((item) => item.sourceKind === "agent_error_alert");
      expect(card?.severity).toBe("critical");
      expect(card?.whyNow).toContain("Automatic resume gave up");
      expect(card?.subject.metadata?.autoResumeAttempts).toBe(4);
    });

    it("resumes the agent once a later attempt brings the container up", async () => {
      const { agentId } = await seedAgent({ updatedAt: new Date(BASE), errorReason: CONTAINER_REASON });
      const startContainer = vi
        .fn<(id: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("health timeout"))
        .mockResolvedValue(undefined);
      const { resumeWake, sweepAt } = makeSweeper({ startContainer });

      await sweepAt(0);
      expect(resumeWake).not.toHaveBeenCalled();
      expect((await agentRow(agentId)).status).toBe("error");

      const second = await sweepAt(15 * MINUTE);
      expect(second.resumed).toBe(1);
      expect(startContainer).toHaveBeenCalledTimes(2);
      expect(resumeWake).toHaveBeenCalledTimes(1);
      const row = await agentRow(agentId);
      expect(row.status).toBe("idle");
      expect(readAutoResumeState(row.metadata)?.containerStartFailures).toBeUndefined();
    });

    it("does not touch other errors, and keeps the old skip when no container can be started", async () => {
      const ordinary = await seedAgent({ updatedAt: new Date(BASE) });
      const startContainer = vi.fn(async () => undefined);
      const withStarter = makeSweeper({ startContainer });
      const resumed = await withStarter.sweepAt(MINUTE);
      expect(resumed.agentIds).toEqual([ordinary.agentId]);
      expect(startContainer).not.toHaveBeenCalled();
      expect((await agentRow(ordinary.agentId)).status).toBe("idle");

      const stuck = await seedAgent({ updatedAt: new Date(BASE), errorReason: CONTAINER_REASON });
      const withoutStarter = makeSweeper();
      const skipped = await withoutStarter.sweepAt(10 * MINUTE);
      expect(skipped.resumed).toBe(0);
      expect(withoutStarter.resumeWake).not.toHaveBeenCalled();
      expect((await agentRow(stuck.agentId)).status).toBe("error");
    });
  });
});
