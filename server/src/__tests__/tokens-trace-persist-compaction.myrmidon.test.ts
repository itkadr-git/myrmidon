import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  llmCallTraces,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { persistLlmCallTraces } from "../myrmidon/tokens-trace/store.js";
import { llmCallTraceInputSchema } from "../myrmidon/tokens-trace/domain.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tokens-trace persist tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function makeCall(overrides: Record<string, unknown> = {}) {
  return llmCallTraceInputSchema.parse({
    langfuseObservationId: randomUUID(),
    litellmRequestId: `lit-${randomUUID()}`,
    model: "claude-sonnet-4-5",
    sections: {
      systemChars: 1000,
      systemTokens: 250,
      toolsChars: 500,
      toolsTokens: 125,
      wakeChars: 200,
      wakeTokens: 50,
      historyChars: 800,
      historyTokens: 200,
      toolResultsChars: 300,
      toolResultsTokens: 75,
      totalChars: 2800,
      totalTokens: 700,
    },
    usage: { promptTokens: 700, cachedPromptTokens: 100, completionTokens: 50 },
    toolsRev: "a".repeat(64),
    compacted: false,
    preCompactChars: null,
    postCompactChars: null,
    ...overrides,
  });
}

describeEmbeddedPostgres("tokens-trace persist compaction path (OPE-10727)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let runId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tokens-trace-persist-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "test-co" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "test-agent",
      role: "engineer",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "OPE-TEST",
      title: "test issue",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
    });
  });

  afterEach(async () => {
    await db.delete(llmCallTraces);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.stop();
  });

  it("persists a non-compacted trace with postCompactChars set and preCompactChars null", async () => {
    const call = makeCall({ compacted: false, preCompactChars: null, postCompactChars: 2800 });
    await persistLlmCallTraces({
      db,
      companyId,
      agentId,
      heartbeatRunId: runId,
      issueId,
      occurredAt: new Date(),
      calls: [call],
    });

    const rows = await db
      .select()
      .from(llmCallTraces)
      .where(eq(llmCallTraces.agentId, agentId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.compacted).toBe(0);
    expect(row.preCompactChars).toBeNull();
    expect(row.postCompactChars).toBe(2800);
    expect(row.promptTokens).toBe(700);
    expect(row.cachedPromptTokens).toBe(100);
  });

  it("persists a compacted trace with preCompactChars set and postCompactChars null (heartbeat mapping)", async () => {
    // Mirrors the heartbeat.ts mapping: compacted=true → pre = totalChars, post = null
    const call = makeCall({ compacted: true, preCompactChars: 2800, postCompactChars: null });
    await persistLlmCallTraces({
      db,
      companyId,
      agentId,
      heartbeatRunId: runId,
      issueId,
      occurredAt: new Date(),
      calls: [call],
    });

    const rows = await db
      .select()
      .from(llmCallTraces)
      .where(eq(llmCallTraces.agentId, agentId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.compacted).toBe(1);
    expect(row.preCompactChars).toBe(2800);
    expect(row.postCompactChars).toBeNull();
  });

  it("stores section size breakdown in dedicated columns", async () => {
    const call = makeCall();
    await persistLlmCallTraces({
      db,
      companyId,
      agentId,
      heartbeatRunId: runId,
      issueId,
      occurredAt: new Date(),
      calls: [call],
    });

    const rows = await db
      .select()
      .from(llmCallTraces)
      .where(eq(llmCallTraces.agentId, agentId));
    const row = rows[0]!;
    expect(row.systemChars).toBe(1000);
    expect(row.toolsChars).toBe(500);
    expect(row.wakeChars).toBe(200);
    expect(row.historyChars).toBe(800);
    expect(row.toolResultsChars).toBe(300);
    expect(row.totalChars).toBe(2800);
  });
});
