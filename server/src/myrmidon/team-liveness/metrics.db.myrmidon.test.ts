import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    // Typed `this` on purpose: the logger children return themselves.
    child: vi.fn(function child(this: unknown) {
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

import {
  AUTO_RESUME_ACTIVITY_ACTION,
  AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION,
} from "../auto-resume.js";
import { RUN_STALL_ERROR_CODE } from "../run-stall/constants.js";
import { readTeamLivenessMetrics, TEAM_LIVENESS_METRIC_WINDOW_MS } from "./metrics.js";

// TEAM-LIVENESS-METRICS: the 24-hour counters behind the health card. The
// point of the suite is that the numbers come from the rows the behaviours
// already write and that the window and the company really bind: a quiet day
// reads zero, and another company's activity never leaks in.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("team liveness metrics", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-team-liveness-metrics-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function recordResume(companyId: string, action: string, at: Date) {
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "auto_resume",
      action,
      entityType: "agent",
      entityId: randomUUID(),
      createdAt: at,
    });
  }

  async function recordWake(companyId: string, agentId: string, at: Date) {
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "idle_pickup",
      status: "queued",
      requestedAt: at,
      createdAt: at,
      updatedAt: at,
    });
  }

  async function recordStall(companyId: string, agentId: string, at: Date) {
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "failed",
      errorCode: RUN_STALL_ERROR_CODE,
      finishedAt: at,
      updatedAt: at,
    });
  }

  it("counts the four sources of one company inside the window", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const hour = 60 * 60 * 1000;
    const companyId = await seedCompany("company-a");
    const agentId = await seedAgent(companyId);

    await recordResume(companyId, AUTO_RESUME_ACTIVITY_ACTION, new Date(now.getTime() - hour));
    await recordResume(companyId, AUTO_RESUME_ACTIVITY_ACTION, new Date(now.getTime() - 2 * hour));
    await recordResume(companyId, AUTO_RESUME_ACTIVITY_ACTION, new Date(now.getTime() - 25 * hour));
    await recordResume(
      companyId,
      AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION,
      new Date(now.getTime() - 3 * hour),
    );
    await recordWake(companyId, agentId, new Date(now.getTime() - 30 * 60 * 1000));
    await recordWake(companyId, agentId, new Date(now.getTime() - 25 * hour));
    await recordStall(companyId, agentId, new Date(now.getTime() - 60 * 1000));

    const metrics = await readTeamLivenessMetrics(db, companyId, now);

    expect(metrics.autoResumes).toBe(2);
    expect(metrics.autoResumeExhaustions).toBe(1);
    expect(metrics.wakes).toBe(1);
    expect(metrics.stalledRuns).toBe(1);
    expect(metrics.windowHours).toBe(24);
    expect(metrics.companyId).toBe(companyId);
    expect(metrics.from).toBe(new Date(now.getTime() - TEAM_LIVENESS_METRIC_WINDOW_MS).toISOString());
    expect(metrics.to).toBe(now.toISOString());
  });

  it("keeps two companies apart", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const hour = 60 * 60 * 1000;
    const first = await seedCompany("company-a");
    const second = await seedCompany("company-b");
    const secondAgent = await seedAgent(second);

    await recordResume(first, AUTO_RESUME_ACTIVITY_ACTION, new Date(now.getTime() - hour));
    await recordResume(second, AUTO_RESUME_ACTIVITY_ACTION, new Date(now.getTime() - hour));
    await recordResume(second, AUTO_RESUME_ACTIVITY_ACTION, new Date(now.getTime() - 2 * hour));
    await recordWake(second, secondAgent, new Date(now.getTime() - hour));
    await recordStall(second, secondAgent, new Date(now.getTime() - hour));

    const firstMetrics = await readTeamLivenessMetrics(db, first, now);
    const secondMetrics = await readTeamLivenessMetrics(db, second, now);

    expect(firstMetrics).toMatchObject({ autoResumes: 1, wakes: 0, stalledRuns: 0 });
    expect(secondMetrics).toMatchObject({ autoResumes: 2, wakes: 1, stalledRuns: 1 });
  });

  it("reads zeros on a quiet day", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const companyId = await seedCompany("company-quiet");

    const metrics = await readTeamLivenessMetrics(db, companyId, now);

    expect(metrics).toMatchObject({
      autoResumes: 0,
      autoResumeExhaustions: 0,
      wakes: 0,
      stalledRuns: 0,
    });
  });

  it("honours another window when asked for one", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const hour = 60 * 60 * 1000;
    const companyId = await seedCompany("company-window");
    await recordResume(companyId, AUTO_RESUME_ACTIVITY_ACTION, new Date(now.getTime() - 3 * hour));

    const day = await readTeamLivenessMetrics(db, companyId, now);
    const hourWindow = await readTeamLivenessMetrics(db, companyId, now, hour);

    expect(day.autoResumes).toBe(1);
    expect(day.windowHours).toBe(24);
    expect(hourWindow.autoResumes).toBe(0);
    expect(hourWindow.windowHours).toBe(1);
  });
});