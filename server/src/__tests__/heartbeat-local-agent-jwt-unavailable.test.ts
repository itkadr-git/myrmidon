import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
} from "@myrmidon/db";
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping local-agent-jwt-unavailable tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("local agent JWT unavailable fail-closed", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  let savedMyrmidonSecret: string | undefined;
  let savedPaperclipSecret: string | undefined;
  let savedBetterAuthSecret: string | undefined;

  const testAdapterType = "mock_local_jwt_fail_closed";
  const execute = vi.fn();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "myrmidon-local-jwt-unavailable-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    registerServerAdapter({
      type: testAdapterType,
      supportsLocalAgentJwt: true,
      execute,
      testEnvironment: async () => ({
        adapterType: testAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 60_000);

  beforeEach(() => {
    execute.mockReset();
    savedMyrmidonSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;
    savedPaperclipSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    savedBetterAuthSecret = process.env.BETTER_AUTH_SECRET;

    delete process.env.MYRMIDON_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
  });

  afterEach(async () => {
    if (savedMyrmidonSecret === undefined) {
      delete process.env.MYRMIDON_AGENT_JWT_SECRET;
    } else {
      process.env.MYRMIDON_AGENT_JWT_SECRET = savedMyrmidonSecret;
    }
    if (savedPaperclipSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = savedPaperclipSecret;
    }
    if (savedBetterAuthSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = savedBetterAuthSecret;
    }

    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    unregisterServerAdapter(testAdapterType);
    await tempDb?.cleanup();
  });

  it("fails legacy run with configuration_incomplete without executing adapter when local run JWT cannot be minted", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "JWT Fail-Closed Company",
      issuePrefix: "JFC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user-1",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "JWT Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: testAdapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished).not.toBeNull();

    // Adapter execution must NOT be called when local agent JWT cannot be minted
    expect(execute).not.toHaveBeenCalled();

    // Run must be marked failed with errorCode configuration_incomplete
    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("configuration_incomplete");

    // resultJson must have code local_agent_jwt_unavailable
    const resultJson = finished?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.code).toBe("local_agent_jwt_unavailable");

    // Reason must be recorded in error
    expect(finished?.error).toContain("Cannot issue PAPERCLIP_API_KEY");
    expect(finished?.error).toContain(testAdapterType);
  });
});
