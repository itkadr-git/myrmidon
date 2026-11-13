// myrmidon(OPE-13021): agent response-probe liveness writes on
// agent_runtime_state. A finalized run that reached the adapter proves the
// runtime was reachable (probe stamp: lastProbeAt/lastProbeOutcome="ok"), and
// a positive model-response sign (token usage, billed cost, or
// failedBeforeModel === false) stamps lastResponseAt. The adapter-failure
// path (the adapter threw; the gateway never answered) proves nothing about
// reachability and stamps neither.
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  type Db,
} from "@myrmidon/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;
const TEST_ADAPTER = "codex_local";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping runtime-state liveness stamp tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const pollDelayMs = 50;
const runFinishTimeoutMs = 10_000;

// A run still in flight may not have written its terminal row yet; this
// integration test polls the real heartbeat service against the embedded
// Postgres, so deterministic fake timers cannot drive the background
// execution loop — a genuine short delay between checks is required.
async function waitForRunToFinish(
  heartbeat: { getRun(runId: string): Promise<unknown> },
  runId: string,
) {
  const deadline = Date.now() + runFinishTimeoutMs;
  while (Date.now() < deadline) {
    const run = (await heartbeat.getRun(runId)) as
      | { status?: string }
      | null
      | undefined;
    if (run && !["queued", "running"].includes(run.status ?? "")) return run;
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
  }
  return heartbeat.getRun(runId);
}

interface LivenessStampState {
  lastProbeAt: Date | null;
  lastProbeOutcome: "ok" | "unreachable" | null;
  lastResponseAt: Date | null;
  lastRunStatus: string | null;
}

async function readLivenessStamps(
  heartbeat: {
    getRuntimeState(agentId: string): Promise<LivenessStampState | null>;
  },
  agentId: string,
): Promise<LivenessStampState> {
  const state = await heartbeat.getRuntimeState(agentId);
  expect(state).not.toBeNull();
  return state!;
}

describeEmbeddedPostgres("runtime-state liveness stamps (OPE-13021)", () => {
  let db!: Db;
  let heartbeat!: {
    invoke(
      agentId: string,
      trigger: "timer" | "assignment" | "on_demand" | "automation",
      contextSnapshot: Record<string, unknown>,
      triggerDetail: "manual" | "ping" | "callback" | "system",
    ): Promise<{ id: string } | null>;
    getRun(runId: string): Promise<unknown>;
    getRuntimeState(agentId: string): Promise<LivenessStampState | null>;
    drainActiveRunExecutions(): Promise<void>;
  };
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const execute = vi.fn<ServerAdapterModule["execute"]>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "heartbeat-liveness-stamps-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: TEST_ADAPTER,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.clearAllMocks();
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "company_skills",
        "heartbeat_run_events",
        "cost_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Liveness stamps",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Liveness Engineer",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("stamps lastProbeAt=ok and lastResponseAt when the run succeeded with token usage", async () => {
    const { agentId } = await seedAgent();
    execute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "codex",
      model: "test-codex",
      summary: "Did the work.",
      usage: { inputTokens: 120, outputTokens: 40 },
      resultJson: { output: "Did the work." },
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect((finished as { status?: string })?.status).toBe("succeeded");

    const state = await readLivenessStamps(heartbeat, agentId);
    expect(state.lastProbeAt).not.toBeNull();
    expect(state.lastProbeOutcome).toBe("ok");
    expect(state.lastResponseAt).not.toBeNull();
    expect(state.lastRunStatus).toBe("succeeded");
  });

  it("stamps the probe but not lastResponseAt when the run failed before the model", async () => {
    const { agentId } = await seedAgent();
    execute.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      provider: "codex",
      model: "test-codex",
      errorMessage: "model unreachable",
      errorCode: "model_unreachable",
      failedBeforeModel: true,
      resultJson: { failed_before_model: true },
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect((finished as { status?: string })?.status).toBe("failed");

    const state = await readLivenessStamps(heartbeat, agentId);
    // The adapter returned a result — the runtime answered at the protocol
    // level, so the process probe stamp is honest. The model never produced
    // work, so lastResponseAt must stay null.
    expect(state.lastProbeAt).not.toBeNull();
    expect(state.lastProbeOutcome).toBe("ok");
    expect(state.lastResponseAt).toBeNull();
  });

  it("stamps lastResponseAt when a failed run reports failedBeforeModel=false", async () => {
    const { agentId } = await seedAgent();
    execute.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      provider: "codex",
      model: "test-codex",
      errorMessage: "turn failed after the model answered",
      errorCode: "turn_failed",
      failedBeforeModel: false,
      resultJson: { modelResponseStarted: true },
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect((finished as { status?: string })?.status).toBe("failed");

    const state = await readLivenessStamps(heartbeat, agentId);
    expect(state.lastProbeOutcome).toBe("ok");
    expect(state.lastResponseAt).not.toBeNull();
  });

  it("does not stamp probe or response when the adapter throws (gateway never answered)", async () => {
    const { agentId } = await seedAgent();
    execute.mockRejectedValue(new Error("ECONNREFUSED gateway down"));

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect((finished as { status?: string })?.status).toBe("failed");

    const state = await readLivenessStamps(heartbeat, agentId);
    // The failure path writes no reachability evidence.
    expect(state.lastProbeAt).toBeNull();
    expect(state.lastProbeOutcome).toBeNull();
    expect(state.lastResponseAt).toBeNull();
  });
});
