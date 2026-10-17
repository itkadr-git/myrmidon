// server/src/myrmidon/input-limit/input-limit.db.myrmidon.test.ts
//
// myrmidon(OPE-6168): the model input-limit pre-check against an embedded
// Postgres: the limit comes from the model catalog (or an agent override), the
// session estimate sums the prompts the board sent into the current session,
// and a recorded fresh-session event starts a new session whose estimate counts
// only the runs after it.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  litellmModels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  INPUT_LIMIT_EVENT_KEY,
  INPUT_LIMIT_FRESH_SESSION_ACTION,
  planInputLimit,
} from "./input-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MODEL = "model-a";
// budget = 1000 tokens * 0.9 = 900 tokens
const WINDOW = 1_000;
const BASE_TIME = Date.parse("2026-10-08T10:00:00.000Z");

describeEmbeddedPostgres("myrmidon(OPE-6168) model input-limit pre-check in the database", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tick = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-input-limit-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(litellmModels);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "agent-a" });
    await db.insert(litellmModels).values({
      id: randomUUID(),
      modelName: MODEL,
      provider: "provider-a",
      maxInputTokens: WINDOW,
      seenAt: new Date(BASE_TIME),
    });
    return { companyId, agentId, issueId: randomUUID() };
  }

  async function seedRun(
    ctx: { companyId: string; agentId: string; issueId: string },
    input: { status?: string; usageJson?: Record<string, unknown> | null; resultJson?: Record<string, unknown> | null },
  ) {
    const id = randomUUID();
    tick += 1;
    await db.insert(heartbeatRuns).values({
      id,
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      status: input.status ?? "succeeded",
      contextSnapshot: { issueId: ctx.issueId },
      usageJson: input.usageJson ?? null,
      resultJson: input.resultJson ?? null,
      createdAt: new Date(BASE_TIME + tick * 1000),
    });
    return id;
  }

  const prompt = (total: number) => ({ promptBreakdown: { parts: { input: total }, total } });

  function plan(ctx: { companyId: string; agentId: string; issueId: string }, config: Record<string, unknown> = { model: MODEL }) {
    return planInputLimit(db, {
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      issueId: ctx.issueId,
      runId: randomUUID(),
      adapterConfig: config,
      overflowFailures: 0,
    });
  }

  it("hands the catalog limit to the adapter and keeps a small session", async () => {
    const ctx = await seed();
    await seedRun(ctx, { usageJson: prompt(300) });
    await seedRun(ctx, { usageJson: prompt(300) });
    const result = await plan(ctx);
    expect(result.hint).toMatchObject({ source: "catalog", maxInputTokens: WINDOW, model: MODEL });
    expect(result.decision.reset).toBe(false);
    expect(result.generation).toBe(1);
  });

  it("starts a fresh session when the session plus the next prompt would not fit", async () => {
    const ctx = await seed();
    await seedRun(ctx, { usageJson: prompt(300) });
    await seedRun(ctx, { usageJson: prompt(300) });
    // A failed run has no usage but its prompt still went into the session.
    await seedRun(ctx, { status: "failed", resultJson: prompt(300) });
    const result = await plan(ctx);
    expect(result.decision).toMatchObject({ reset: true, sessionTokens: 900, expectedTokens: 1200, budgetTokens: 900 });
    expect(result.generation).toBe(2);
  });

  it("counts only the runs after a recorded reset, and keeps the generation", async () => {
    const ctx = await seed();
    await seedRun(ctx, { usageJson: prompt(500) });
    await seedRun(ctx, { usageJson: prompt(500) });
    const resetRun = await seedRun(ctx, { usageJson: prompt(100) });
    await db.insert(heartbeatRunEvents).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      runId: resetRun,
      seq: 1,
      eventType: "lifecycle",
      payload: { [INPUT_LIMIT_EVENT_KEY]: { action: INPUT_LIMIT_FRESH_SESSION_ACTION } },
    });
    await seedRun(ctx, { usageJson: prompt(100) });
    const result = await plan(ctx);
    // The new session holds the reset run and the one after it: 200 tokens.
    expect(result.decision.reset).toBe(false);
    expect(result.priorResets).toBe(1);
    expect(result.generation).toBe(2);
  });

  it("does not count a session across a provider overflow rejection", async () => {
    const ctx = await seed();
    await seedRun(ctx, { usageJson: prompt(800) });
    await seedRun(ctx, { status: "failed", resultJson: { ...prompt(800), errorFamily: "input_overflow" } });
    await seedRun(ctx, { usageJson: prompt(100) });
    const result = await plan(ctx);
    expect(result.decision.reset).toBe(false);
  });

  it("ignores runs of other issues and cancelled runs", async () => {
    const ctx = await seed();
    await seedRun({ ...ctx, issueId: randomUUID() }, { usageJson: prompt(900) });
    await seedRun(ctx, { status: "cancelled", usageJson: prompt(900) });
    await seedRun(ctx, { usageJson: prompt(100) });
    expect((await plan(ctx)).decision.reset).toBe(false);
  });

  it("prefers an agent override to the catalog and invents nothing for an unknown model", async () => {
    const ctx = await seed();
    const override = await plan(ctx, { model: MODEL, inputLimitTokens: 500 });
    expect(override.hint).toMatchObject({ source: "config", maxInputTokens: 500 });
    const unknown = await plan(ctx, { model: "no-such-model" });
    expect(unknown.hint).toBeNull();
    expect(unknown.decision.reset).toBe(false);
  });
});
