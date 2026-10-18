// server/src/myrmidon/prompt-budget/status.db.myrmidon.test.ts
//
// myrmidon(1.6.5 F-15 D): the batched per-agent last-prompt read must return
// EXACTLY what the old per-agent N+1 loop returned.
//
// The batched read (`loadLastPromptRuns` — one lateral statement) is compared
// against a reference implementation that re-issues the old per-agent query
// shape (one `order by coalesce(finished_at, started_at) desc limit 20` round
// trip per agent) and scans the rows with the same pure parser. The fixture is
// the ticket's 5 agents x 10 runs plus the hard edges: a newest-runs-without-
// breakdown skip, the inputTokens fallback, an agent with no usable run, an
// agent with no runs at all, the top-20 window boundary on both sides, the
// null finished_at fallback, cross-company filtering, and the full
// buildPromptBudgetStatus assembly over the batched map.

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { defaultPromptBudgetSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  PROMPT_BUDGET_SCAN_LIMIT,
  buildPromptBudgetStatus,
  loadLastPromptRuns,
  type PromptBudgetLastRun,
} from "./status.js";
import { parsePromptBreakdown } from "../prompt-budget-advice/source.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("myrmidon(1.6.5 F-15 D) batched last-prompt read equals the old per-agent N+1", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-prompt-budget-batch-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  beforeEach(async () => {
    companyId = randomUUID();
    await db
      .insert(companies)
      .values({ id: companyId, name: "batch-eq-co", issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase() });
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    companyId = "";
  });

  async function seedAgent(name: string, atCompany = companyId): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: atCompany, name });
    return agentId;
  }

  /** Insert one run; `minutesAgo` sets the activity time (finished from it). */
  async function seedRun(
    agentId: string,
    usageJson: Record<string, unknown> | null,
    minutesAgo: number,
    opts: { finishedAt?: Date | null; atCompany?: string } = {},
  ): Promise<string> {
    const runId = randomUUID();
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const finishedAt = opts.finishedAt === undefined ? at : opts.finishedAt;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.atCompany ?? companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date(at.getTime() - 60_000),
      finishedAt,
      usageJson,
    });
    return runId;
  }

  function breakdown(total: number): Record<string, unknown> {
    return {
      promptBreakdown: { total, parts: { system: Math.round(total * 0.4), history: total } },
    };
  }
  /** A usage row WITHOUT a breakdown: inputTokens still parses (fallback). */
  function inputOnly(total: number): Record<string, unknown> {
    return { inputTokens: total };
  }

  /**
   * Reference: the old loop's exact per-agent query shape (one round trip per
   * agent, default nulls-first DESC order), scanned with the same pure parser.
   * NOT the batched code path.
   */
  async function referenceLastPromptRun(
    dbHandle: Db,
    id: string,
    agentId: string,
  ): Promise<PromptBudgetLastRun | null> {
    const rows = await dbHandle
      .select({ id: heartbeatRuns.id, usageJson: heartbeatRuns.usageJson })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, id), eq(heartbeatRuns.agentId, agentId)))
      .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt})`))
      .limit(PROMPT_BUDGET_SCAN_LIMIT);
    for (const row of rows) {
      const parsed = parsePromptBreakdown(row.usageJson);
      if (parsed) return { runId: row.id, total: parsed.total, parts: parsed.parts };
    }
    return null;
  }

  it("5 agents x 10 runs: one batched read returns what the N+1 loop returned", async () => {
    const ids: string[] = [];
    // agent 0: all runs usable — newest wins.
    ids.push(await seedAgent("a0"));
    for (let i = 0; i < 10; i += 1) await seedRun(ids[0]!, breakdown(1000 + i), (i + 1) * 10);
    // agent 1: the 4 newest runs have NO breakdown, older ones do — the scan
    // must skip forward through the window exactly like the old loop.
    ids.push(await seedAgent("a1"));
    for (let i = 0; i < 4; i += 1) await seedRun(ids[1]!, { note: "no usage" }, (i + 1) * 10);
    for (let i = 4; i < 10; i += 1) await seedRun(ids[1]!, breakdown(500 + i), (i + 1) * 10);
    // agent 2: newest run parses only via the inputTokens fallback.
    ids.push(await seedAgent("a2"));
    await seedRun(ids[2]!, inputOnly(777), 1);
    for (let i = 1; i < 10; i += 1) await seedRun(ids[2]!, breakdown(100 + i), (i + 1) * 10);
    // agent 3: NO usable run at all.
    ids.push(await seedAgent("a3"));
    for (let i = 0; i < 10; i += 1) await seedRun(ids[3]!, { empty: true }, (i + 1) * 10);
    // agent 4: no runs at all.
    ids.push(await seedAgent("a4"));

    const batched = await loadLastPromptRuns(db, companyId, ids);
    for (const agentId of ids) {
      const expected = await referenceLastPromptRun(db, companyId, agentId);
      expect(batched.get(agentId) ?? null).toEqual(expected);
    }
    // Sanity that the fixture actually produced hits (guards against an
    // all-null comparison passing vacuously).
    expect(batched.size).toBe(3);
  });

  it("the top-20 window boundary behaves like the old per-agent limit", async () => {
    // Agent A: exactly 20 junk runs fill the window; the only usable run sits
    // at #21 — OUTSIDE. The old loop would never see it; neither may the
    // batched read.
    const outsideAgent = await seedAgent("window-outside");
    for (let i = 1; i <= PROMPT_BUDGET_SCAN_LIMIT; i += 1) {
      await seedRun(outsideAgent, { junk: true }, i);
    }
    await seedRun(outsideAgent, breakdown(4242), PROMPT_BUDGET_SCAN_LIMIT + 1);

    const batchedOutside = await loadLastPromptRuns(db, companyId, [outsideAgent]);
    expect(batchedOutside.has(outsideAgent)).toBe(false);
    expect(batchedOutside.get(outsideAgent) ?? null).toEqual(
      await referenceLastPromptRun(db, companyId, outsideAgent),
    );

    // Agent B: 19 junk runs, the usable one at #20 — the last slot INSIDE the
    // window. Both paths must pick it.
    const insideAgent = await seedAgent("window-inside");
    for (let i = 1; i < PROMPT_BUDGET_SCAN_LIMIT; i += 1) {
      await seedRun(insideAgent, { junk: true }, i);
    }
    const insideRun = await seedRun(insideAgent, breakdown(99), PROMPT_BUDGET_SCAN_LIMIT);

    const batchedInside = await loadLastPromptRuns(db, companyId, [insideAgent]);
    expect(batchedInside.get(insideAgent)?.runId).toBe(insideRun);
    expect(batchedInside.get(insideAgent)).toEqual(
      await referenceLastPromptRun(db, companyId, insideAgent),
    );

    // One call for both agents — and it agrees with two reference round trips.
    const both = await loadLastPromptRuns(db, companyId, [outsideAgent, insideAgent]);
    expect(both.size).toBe(1);
  });

  it("a null finished_at falls back to started_at in the ordering, like the old coalesce read", async () => {
    const agentId = await seedAgent("null-finish");
    // Newest by started_at but finished_at null: coalesce picks started_at.
    // (Old default DESC order is NULLS FIRST; both finished AND started null
    // would sort the run to the top — covered by the reference comparison.)
    const runStartedRecently = await seedRun(agentId, breakdown(111), 5, { finishedAt: null });
    // Older completed run.
    await seedRun(agentId, breakdown(222), 60);

    const batched = await loadLastPromptRuns(db, companyId, [agentId]);
    expect(batched.get(agentId)?.runId).toBe(runStartedRecently);
    expect(batched.get(agentId)?.total).toBe(111);
  });

  it("runs of OTHER companies never leak into the batched read", async () => {
    const otherCompany = randomUUID();
    await db
      .insert(companies)
      .values({ id: otherCompany, name: "other-co", issuePrefix: otherCompany.replace(/-/g, "").slice(0, 8).toUpperCase() });
    const agentId = await seedAgent("mine");
    const mine = await seedRun(agentId, breakdown(10), 30);
    // A foreign company's agent with a newer usable run: the batched read is
    // keyed by MY agent ids and filtered by company_id — it must stay away.
    const foreignAgent = await seedAgent("foreign", otherCompany);
    await seedRun(foreignAgent, breakdown(9999), 1, { atCompany: otherCompany });

    const batched = await loadLastPromptRuns(db, companyId, [agentId]);
    expect(batched.get(agentId)?.runId).toBe(mine);

    const foreignBatch = await loadLastPromptRuns(db, otherCompany, [agentId, foreignAgent]);
    expect(foreignBatch.get(foreignAgent)?.total).toBe(9999);
    expect(foreignBatch.has(agentId)).toBe(false);
  });

  it("buildPromptBudgetStatus stays stable and consumes the batched map", async () => {
    const ids: string[] = [];
    ids.push(await seedAgent("zeta"));
    ids.push(await seedAgent("alpha"));
    await seedRun(ids[0]!, breakdown(150_000), 10);
    // ids[1]: no runs.
    const settings = defaultPromptBudgetSettings();
    const statuses = await buildPromptBudgetStatus(db, companyId, settings);
    expect(statuses.map((s) => s.agentId)).toEqual([...ids].sort((l, r) => l.localeCompare(r)));
    const withRun = statuses.find((s) => s.agentId === ids[0])!;
    expect(withRun.lastRun?.total).toBe(150_000);
    expect(withRun.windowIsFallback).toBe(true); // no litellm_models row yet
    const withoutRun = statuses.find((s) => s.agentId === ids[1])!;
    expect(withoutRun.lastRun).toBeNull();
    expect(withoutRun.windowIsFallback).toBe(true);
  });
});
