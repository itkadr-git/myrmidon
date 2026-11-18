import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const gateway = vi.hoisted(() => ({
  issued: new Map<string, string>(),
  active: new Set<string>(),
}));
vi.mock("../myrmidon/litellm-keys/run-keys.js", () => ({
  mintRunGatewayKey: async (_deps: unknown, input: { runId: string }) => {
    const value = `test-run-key-${input.runId}`;
    gateway.issued.set(input.runId, value);
    gateway.active.add(value);
    return { value, secretName: input.runId, expiresAt: new Date().toISOString() };
  },
  revokeRunGatewayKey: async (_deps: unknown, input: { runId: string }) => {
    const value = gateway.issued.get(input.runId);
    if (value) gateway.active.delete(value);
  },
}));

import { heartbeatService } from "../services/heartbeat.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("heartbeat run credential lifecycle", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let previousEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    previousEnv = { ...process.env };
    process.env.MYRMIDON_LITELLM_BASE_URL = "http://gateway.test";
    process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET = "test-admin";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "heartbeat-run-key-test-jwt";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-key-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql.raw('TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE'));
    gateway.issued.clear();
    gateway.active.clear();
  });
  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb.cleanup();
    process.env = previousEnv;
  });

  async function setup(script: string, timeoutSec = 0) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Process", role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", script], timeoutSec, graceSec: 1 }, runtimeConfig: {}, permissions: {} });
    return { companyId, agentId };
  }

  async function waitFor(runId: string, predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`run ${runId} did not reach expected state`);
  }

  it.each([
    { outcome: "success", script: "console.log(process.env.MYRMIDON_LLM_API_KEY)", status: "succeeded", timeout: 0 },
    { outcome: "failure", script: "console.log(process.env.MYRMIDON_LLM_API_KEY); process.exit(1)", status: "failed", timeout: 0 },
    { outcome: "timeout", script: "console.log(process.env.MYRMIDON_LLM_API_KEY); setInterval(() => {}, 1000)", status: "timed_out", timeout: 1 },
    { outcome: "cancel", script: "console.log(process.env.MYRMIDON_LLM_API_KEY); setInterval(() => {}, 1000)", status: "cancelled", timeout: 0 },
  ])("revokes and redacts the credential after $outcome", async ({ outcome, script, status, timeout }) => {
    const { companyId, agentId } = await setup(script, timeout);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    const runId = run!.id;
    await waitFor(runId, async () => gateway.issued.has(runId));
    const key = gateway.issued.get(runId)!;
    if (outcome === "cancel") {
      await waitFor(runId, async () => (await heartbeat.getRun(runId))?.status === "running");
      await heartbeat.cancelRun(runId, "test cancellation");
    }
    await waitFor(runId, async () => !["queued", "running"].includes((await heartbeat.getRun(runId))?.status ?? "queued"));
    await heartbeat.drainActiveRunExecutions();
    expect((await heartbeat.getRun(runId))?.status).toBe(status);
    expect(gateway.active.has(key)).toBe(false);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const redacted = await createRunSecretRedactionRegistry(db).redactForRun(companyId, runId, events);
    expect(JSON.stringify(redacted)).not.toContain(key);
    expect(await createRunSecretRedactionRegistry(db).redactForRun(companyId, runId, key)).not.toContain(key);
  }, 45_000);
});
