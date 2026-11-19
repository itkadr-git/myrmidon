import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyModelGroupRules, createDb } from "@myrmidon/db";
import { registerServerAdapter, unregisterServerAdapter, type ServerAdapterModule } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

describe("parallel heartbeat step model selection", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const execute = vi.fn<ServerAdapterModule["execute"]>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("step-model-parallel-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: "hermes_gateway", supportsLocalAgentJwt: false, execute,
      testEnvironment: async () => ({ adapterType: "hermes_gateway", status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
  }, 60_000);

  afterAll(async () => {
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter("hermes_gateway");
    await tempDb?.cleanup();
  });

  it("persists independent decisions and dispatches each selected group", async () => {
    const companyId = randomUUID();
    const agentIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({ id: companyId, name: "Parallel models", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values(agentIds.map((id) => ({ id, companyId, name: id, role: "engineer", status: "idle", adapterType: "hermes_gateway", adapterConfig: { model: "fallback" }, runtimeConfig: {}, permissions: {} })));
    await db.insert(companyModelGroupRules).values([
      { companyId, stepClass: "review", modelGroup: "company-review", casteKey: null },
      { companyId, stepClass: "review", modelGroup: "caste-review", casteKey: "engineer" },
      { companyId, stepClass: "execution", modelGroup: "company-execution", casteKey: null },
    ]);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    execute.mockImplementation(async () => {
      await barrier;
      return { exitCode: 0, signal: null, timedOut: false, provider: "hermes_gateway", model: "test", summary: "completed", resultJson: { output: "completed" } };
    });
    try {
      const [review, execution] = await Promise.all([
        heartbeat.invoke(agentIds[0]!, "on_demand", { stepClass: "review" }, "manual"),
        heartbeat.invoke(agentIds[1]!, "on_demand", { stepClass: "execution" }, "manual"),
      ]);
      expect(review).not.toBeNull();
      expect(execution).not.toBeNull();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), { timeout: 30_000 });
      const expected = [
        { id: review!.id, stepClass: "review", group: "caste-review", reason: "caste_rule" },
        { id: execution!.id, stepClass: "execution", group: "company-execution", reason: "company_rule" },
      ];
      for (const item of expected) {
        const run = await heartbeat.getRun(item.id);
        expect(run).toMatchObject({ status: "running", stepClass: item.stepClass, stepModelGroup: item.group, stepModel: item.group, stepModelReason: item.reason });
        expect(run?.stepModelSnapshotJson).toMatchObject({ stepClass: item.stepClass, modelGroup: item.group, model: item.group, reason: item.reason });
        const call = execute.mock.calls.find(([input]) => input.runId === item.id)?.[0];
        expect(call?.config).toMatchObject({ model: item.group, modelGroup: item.group });
      }
      await db.delete(companyModelGroupRules);
      for (const item of expected) {
        expect((await heartbeat.getRun(item.id))?.stepModelSnapshotJson).toMatchObject({ modelGroup: item.group, model: item.group, reason: item.reason });
      }
    } finally {
      release();
    }
  }, 60_000);
});
