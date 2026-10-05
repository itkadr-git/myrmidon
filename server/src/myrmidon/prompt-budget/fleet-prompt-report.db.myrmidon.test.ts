// server/src/myrmidon/prompt-budget/fleet-prompt-report.db.myrmidon.test.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET D): the fleet prompt report against an embedded
// Postgres and the real cost service. Covers the fixture of the acceptance
// criteria (two agents, different runs), the input-token fallback of a run
// without a prompt breakdown, the empty share while no threshold is
// configured, and a cross-check of the numbers against a direct SQL query.
//
// Red side (main without this change): `byAgent` rows carry neither
// `avgPromptTokens` nor `runsAboveThresholdPct`, so every assertion fails.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  instanceSettings,
  litellmModels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { costService } from "../../services/costs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MODEL = "model-a";
const MODEL_WINDOW = 100_000;
const BILLING_TYPE = "metered_api";
const OCCURRED_AT = new Date("2026-10-03T10:00:00.000Z");

describeEmbeddedPostgres("myrmidon(1.6.3 PROMPT-BUDGET D) fleet prompt report in the database", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-prompt-report-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(litellmModels);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, usageJson: Record<string, unknown> | null) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      usageJson,
    });
    return runId;
  }

  async function seedCostEvent(input: {
    companyId: string;
    agentId: string;
    runId: string;
    model?: string;
    inputTokens: number;
    costCents: number;
  }) {
    await db.insert(costEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      heartbeatRunId: input.runId,
      provider: "provider-a",
      biller: "provider-a",
      billingType: BILLING_TYPE,
      model: input.model ?? MODEL,
      inputTokens: input.inputTokens,
      costCents: input.costCents,
      occurredAt: OCCURRED_AT,
    });
  }

  async function seedBudgetSettings(warnPct: number) {
    await db.insert(instanceSettings).values({
      general: { promptBudget: { enabled: true, warnPct, critPct: 90 } },
    });
  }

  /** Two agents: agent-a has a recorded breakdown and a bare run, agent-b one recorded run. */
  async function seedFleet() {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "agent-a");
    const agentB = await seedAgent(companyId, "agent-b");

    const runA1 = await seedRun(companyId, agentA, { promptBreakdown: { parts: { instructions: 800 }, total: 1_000 } });
    const runA2 = await seedRun(companyId, agentA, null);
    const runB1 = await seedRun(companyId, agentB, { promptBreakdown: { parts: { history: 60_000 }, total: 60_000 } });

    await seedCostEvent({ companyId, agentId: agentA, runId: runA1, inputTokens: 900, costCents: 10 });
    await seedCostEvent({ companyId, agentId: agentA, runId: runA2, inputTokens: 3_000, costCents: 20 });
    await seedCostEvent({ companyId, agentId: agentB, runId: runB1, inputTokens: 58_000, costCents: 30 });

    await db.insert(litellmModels).values({
      id: randomUUID(),
      modelName: MODEL,
      provider: "provider-a",
      maxInputTokens: MODEL_WINDOW,
      seenAt: OCCURRED_AT,
    });

    return { companyId, agentA, agentB };
  }

  it("adds the prompt columns without touching the existing ones", async () => {
    const { companyId, agentA, agentB } = await seedFleet();

    const rows = await costService(db).byAgent(companyId);
    const rowA = rows.find((row) => row.agentId === agentA);
    const rowB = rows.find((row) => row.agentId === agentB);

    // Existing columns stay as they were.
    expect(rowA).toMatchObject({
      agentName: "agent-a",
      costCents: 30,
      inputTokens: 3_900,
      apiRunCount: 2,
      subscriptionRunCount: 0,
    });

    // agent-a: (1000 recorded + 3000 input tokens of the bare run) / 2 runs.
    expect(rowA?.avgPromptTokens).toBe(2_000);
    expect(rowB?.avgPromptTokens).toBe(60_000);

    // No threshold settings stored: the share stays empty instead of failing.
    expect(rowA?.runsAboveThresholdPct).toBeNull();
    expect(rowB?.runsAboveThresholdPct).toBeNull();
  });

  it("counts the share of runs above the configured threshold", async () => {
    const { companyId, agentA, agentB } = await seedFleet();
    await seedBudgetSettings(50);

    const rows = await costService(db).byAgent(companyId);
    const rowA = rows.find((row) => row.agentId === agentA);
    const rowB = rows.find((row) => row.agentId === agentB);

    // Threshold = 50% of the 100k window = 50k tokens.
    // agent-a: 1k and 3k are below it; agent-b: 60k is above it.
    expect(rowA?.runsAboveThresholdPct).toBe(0);
    expect(rowB?.runsAboveThresholdPct).toBe(100);
  });

  it("leaves a run with an unknown model window out of the share, not out of the average", async () => {
    const { companyId, agentA } = await seedFleet();
    const runA3 = await seedRun(companyId, agentA, { promptBreakdown: { parts: { history: 90_000 }, total: 90_000 } });
    await seedCostEvent({ companyId, agentId: agentA, runId: runA3, model: "model-unknown", inputTokens: 90_000, costCents: 40 });
    await seedBudgetSettings(50);

    const rows = await costService(db).byAgent(companyId);
    const rowA = rows.find((row) => row.agentId === agentA);

    expect(rowA?.avgPromptTokens).toBe(Math.round((1_000 + 3_000 + 90_000) / 3));
    expect(rowA?.runsAboveThresholdPct).toBe(0);
  });

  it("agrees with a direct aggregate over the database", async () => {
    const { companyId } = await seedFleet();

    const result = await db.execute(sql`
      select per_run.agent_id::text as "agentId",
             round(avg(per_run.prompt_tokens))::int as "avgPromptTokens",
             count(*)::int as "runCount"
      from (
        select ${costEvents.agentId} as agent_id,
               ${costEvents.heartbeatRunId} as heartbeat_run_id,
               coalesce(
                 nullif(${heartbeatRuns.usageJson} #>> '{promptBreakdown,total}', '')::double precision,
                 sum(${costEvents.inputTokens})
               ) as prompt_tokens
        from ${costEvents}
        left join ${heartbeatRuns} on ${heartbeatRuns.id} = ${costEvents.heartbeatRunId}
        where ${costEvents.companyId} = ${companyId} and ${costEvents.heartbeatRunId} is not null
        group by ${costEvents.agentId}, ${costEvents.heartbeatRunId}, ${heartbeatRuns.usageJson}
      ) per_run
      group by per_run.agent_id
    `);
    const direct = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{
      agentId: string;
      avgPromptTokens: number;
      runCount: number;
    }>;

    const rows = await costService(db).byAgent(companyId);
    expect(direct).toHaveLength(2);
    for (const expected of direct) {
      expect(rows.find((row) => row.agentId === expected.agentId)?.avgPromptTokens).toBe(
        Number(expected.avgPromptTokens),
      );
    }
  });

  it("leaves the report empty for a company without cost events", async () => {
    const companyId = await seedCompany();

    await expect(costService(db).byAgent(companyId)).resolves.toEqual([]);
  });
});