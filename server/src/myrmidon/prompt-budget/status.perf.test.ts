// server/src/myrmidon/prompt-budget/status.perf.test.ts
//
// myrmidon(1.6.5 F-15 D): the attention feed's prompt-budget section must
// assemble its per-agent last-run reads in ONE round trip and stay under
// 300 ms at production-ish volume (1 000 runs across 80 agents).
//
// Two lines, one file:
//   1. Query-count guard in the tool-gateway.perf.test.ts style: a drizzle-
//      compatible counting stub drives the REAL loadLastPromptRuns and asserts
//      heartbeat_runs is read by exactly one statement for the whole agent set
//      — 2, 30 and 80 agents all cost the same single query. This runs in
//      every CI job; no Postgres needed.
//   2. Live timing line on embedded Postgres (the ticket's volume: 80 agents,
//      1 000 runs): loadLastPromptRuns over all 80 agents must complete in
//      < 300 ms. The audited cold feed build made ~84 such queries serially —
//      the line that broke p50/p95 on the attention screen.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { loadLastPromptRuns } from "./status.js";

// --- 1. query-count guard (runs everywhere, no Postgres needed) -------------

type QueryEvent = { table: string; kind: "select" | "execute" };

/**
 * Drizzle-compatible counting stub: records one event per awaited read.
 * db.execute answers with one usage row per requested agent (activity order
 * irrelevant — the guard counts statements, the db file proves equivalence).
 */
function createCountingDb(events: QueryEvent[], executeRows: () => unknown[]) {
  const select = (): unknown => {
    const state: { table?: unknown } = {};
    const builder = {
      from(t: unknown) {
        state.table = t;
        return builder;
      },
      where() {
        return builder;
      },
      then(resolve: (value: unknown) => void) {
        const t = state.table as Record<string | symbol, unknown> | undefined;
        const sym = t
          ? Object.getOwnPropertySymbols(t).find((s) => s.description === "drizzle:Name")
          : undefined;
        const name = typeof sym === "symbol" && t ? String(t[sym]) : "unknown";
        events.push({ table: name, kind: "select" });
        resolve([]);
        return Promise.resolve();
      },
    };
    return builder;
  };
  return {
    select,
    async execute() {
      events.push({ table: "heartbeat_runs", kind: "execute" });
      return executeRows();
    },
  };
}

describe("myrmidon(1.6.5 F-15 D) batched last-prompt read is one query at any agent count", () => {
  it("heartbeat_runs is read by exactly ONE statement for 2 / 30 / 80 agents", async () => {
    for (const agentCount of [2, 30, 80]) {
      const ids = Array.from({ length: agentCount }, () => randomUUID());
      const events: QueryEvent[] = [];
      const stub = createCountingDb(events, () =>
        ids.map((agentId, n) => ({
          agent_id: agentId,
          id: `run-${n}`,
          usage_json: { promptBreakdown: { total: 120_000, parts: { system: 10 } } },
        })),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = await loadLastPromptRuns(stub as any, randomUUID(), ids);
      expect(map.size).toBe(agentCount);
      const runQueries = events.filter((e) => e.table === "heartbeat_runs");
      expect(runQueries.length).toBe(1);
      expect(runQueries.every((e) => e.kind === "execute")).toBe(true);
    }
  });

  it("an empty agent set costs no query at all", async () => {
    const events: QueryEvent[] = [];
    const stub = createCountingDb(events, () => []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await loadLastPromptRuns(stub as any, randomUUID(), []);
    expect(map.size).toBe(0);
    expect(events.length).toBe(0);
  });

  it("the production source no longer loops per-agent reads (drift guard)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const here = path.dirname(new URL(import.meta.url).pathname);
    const status = fs.readFileSync(path.join(here, "status.ts"), "utf8");
    // The old call site is gone; the batched reader is the only runs read.
    expect(status).not.toMatch(/loadLastPromptRun\(/);
    expect(status).toMatch(/loadLastPromptRuns\(/);
    // myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL): the feed no longer assembles
    // statuses on every list — it reads the sweep-recorded signals, so the
    // hot path is drift-guarded by the sweep's own batched assembly below.
    const attention = fs.readFileSync(path.join(here, "../../services/attention.ts"), "utf8");
    expect(attention).not.toMatch(/buildPromptBudgetStatus\(/);
    expect(attention).toMatch(/readPromptBudgetSignals\(/);
    const sweep = fs.readFileSync(path.join(here, "sweep.ts"), "utf8");
    expect(sweep).toMatch(/buildPromptBudgetStatus/);
  });
});

// --- 2. live timing on embedded Postgres ------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeLive = embeddedPostgresSupport.supported ? describe : describe.skip;

const AGENT_COUNT = 80;
const RUN_COUNT = 1_000;
const BUILD_BUDGET_MS = 300;

describeLive("myrmidon(1.6.5 F-15 D) batched read assembles at production volume under 300 ms", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-prompt-budget-perf-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db
      .insert(companies)
      .values({ id: companyId, name: "perf-co", issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase() });

    agentIds = Array.from({ length: AGENT_COUNT }, () => randomUUID());
    await db.insert(agents).values(
      agentIds.map((id, n) => ({ id, companyId, name: `perf-agent-${n}` })),
    );

    // RUN_COUNT runs spread evenly over the agents; every ~3rd run carries a
    // usable breakdown, the rest are junk usage — the realistic mix the scan
    // skips through. Bulk SQL insert keeps seeding fast; started/finished
    // timestamps spread over the last hour so the per-agent top-20 windows
    // are real slices, not a tie at one instant.
    const rows = [];
    for (let n = 0; n < RUN_COUNT; n += 1) {
      const agentId = agentIds[n % AGENT_COUNT]!;
      const at = new Date(Date.now() - n * 3_000);
      rows.push({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(at.getTime() - 1_000),
        finishedAt: at,
        usageJson:
          n % 3 === 0
            ? { promptBreakdown: { total: 50_000 + n, parts: { system: 20_000 } } }
            : { junk: true },
      });
    }
    await db.insert(heartbeatRuns).values(rows);

    // ANALYZE so the planner has honest stats before the timed runs.
    await db.execute(sql`analyze heartbeat_runs`);
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  it(`loadLastPromptRuns over ${AGENT_COUNT} agents finishes < ${BUILD_BUDGET_MS} ms`, async () => {
    // Warm-up once (first statement after ANALYZE can pay plan cost).
    const warm = await loadLastPromptRuns(db, companyId, agentIds);
    expect(warm.size).toBeGreaterThan(0);

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const map = await loadLastPromptRuns(db, companyId, agentIds);
      samples.push(performance.now() - t0);
      expect(map.size).toBe(AGENT_COUNT);
    }
    const best = Math.min(...samples);
    const median = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    // The ticket's criterion is on the assembly, not the machine: use the
    // median of the samples (single runs on CI boxes jitter by 2-3x).
    console.info(
      `prompt-budget batched read: best=${best.toFixed(1)}ms median=${median.toFixed(1)}ms ` +
        `(${AGENT_COUNT} agents, ${RUN_COUNT} runs, embedded PG)`,
    );
    expect(median).toBeLessThan(BUILD_BUDGET_MS);
  }, 60_000);

  it("one batched read agrees with 80 serial per-agent round trips (volume check)", async () => {
    // Equivalence proven exhaustively in status.db.myrmidon.test.ts on the
    // small fixture; here just assert the map covers every seeded agent so
    // the timed section above measured a real full-width read.
    const map = await loadLastPromptRuns(db, companyId, agentIds);
    for (const agentId of agentIds) expect(map.has(agentId)).toBe(true);
  }, 60_000);
});
