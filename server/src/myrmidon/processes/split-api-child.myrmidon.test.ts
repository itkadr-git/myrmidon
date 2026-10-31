// myrmidon(OPE-10011): two defects of a split board seen on the stand, on a
// REAL database and a REAL process bus (Postgres LISTEN/NOTIFY).
//
//  1. A PATCH /api/myrmidon/processes that lands on an api child stored the row
//     but never reached the worker's supervisor — the processes service did
//     not publish `settings_changed`, so the worker never re-read the row.
//     Here the "api process" and the "worker process" are two ProcessBus
//     instances with their own LISTEN connections on one database, the api
//     side runs the production settings service, the worker side the
//     production settings appliers.
//  2. The api child ran the queued-run resweep (and through it the run
//     admission): every heartbeatService() built by a route or a service
//     armed its own resweep, because `executesRuns` defaulted to true. It now
//     defaults to the process role.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createPostgresJsClient } from "@myrmidon/db";
import type { ProcessesSettings } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { logger } from "../../middleware/logger.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { ProcessBus } from "../../services/process-bus.js";
import { registerSettingsAppliers } from "../settings-appliers/index.js";
import { createProcessesSettingsService, defaultProcessesSettingsDeps } from "./service.js";
import type { ProcessSupervisor } from "./supervisor.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true, reason: undefined }
  : await getEmbeddedPostgresTestSupport();
const describeDb = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping the OPE-10011 split api child suite: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const ACTOR = {
  actorType: "user" as const,
  actorId: "local-board",
  sessionId: "session-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
  actorSource: "session" as const,
};

const RESWEEP_NOT_ARMED = "queued run resweep is not armed in this process";

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The worker's supervisor, reduced to what the appliers call. */
function recordingSupervisor(applied: ProcessesSettings[]): ProcessSupervisor {
  return {
    apply: async (settings) => {
      applied.push(settings);
    },
    adoptPublicListener: async () => undefined,
    state: () => "single",
    children: () => [],
    shutdown: async () => undefined,
  };
}

/** A process environment for one role, outside the test-runner arming rule. */
function roleEnv(role: "api" | "worker"): Record<string, string | undefined> {
  return { ...process.env, MYRMIDON_PROCESS_ROLE: role, NODE_ENV: "production", VITEST: "" };
}

describeDb("split board: api child on a real database and process bus (OPE-10011)", () => {
  let database: EmbeddedPostgresTestDatabase | null = null;
  let connectionString = "";
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      connectionString = externalTestDatabaseUrl;
    } else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-ope10011-");
      connectionString = database.connectionString;
    }
    db = createDb(connectionString);
  }, 120_000);

  afterAll(async () => {
    if (database) await database.cleanup();
  });

  it("a processes PATCH saved on an api process reaches the worker's supervisor", async () => {
    const workerSql = createPostgresJsClient(connectionString, { maxConnections: 2 });
    const apiSql = createPostgresJsClient(connectionString, { maxConnections: 2 });
    const workerBus = new ProcessBus(workerSql, { bootId: `worker-${randomUUID()}` });
    const apiBus = new ProcessBus(apiSql, { bootId: `api-${randomUUID()}` });
    const applied: ProcessesSettings[] = [];
    // The worker: settings appliers on its bus, its supervisor behind them.
    const unsubscribe = registerSettingsAppliers(workerBus, { db: db as never, processSupervisor: recordingSupervisor(applied) });
    try {
      await workerBus.start();
      await apiBus.start();
      // The api child: no supervisor of its own, only the bus of its process.
      const apiService = createProcessesSettingsService(defaultProcessesSettingsDeps(db as never, null, apiBus));

      await apiService.update({ mode: "split", apiCount: 2 }, ACTOR);
      await waitFor(() => applied.length > 0, "the worker supervisor to apply the split");
      expect(applied.at(-1)).toMatchObject({ mode: "split", apiCount: 2 });

      await apiService.update({ apiCount: 1 }, ACTOR);
      await waitFor(() => applied.some((value) => value.apiCount === 1), "the worker supervisor to apply apiCount=1");

      await apiService.update({ mode: "single" }, ACTOR);
      await waitFor(() => applied.at(-1)?.mode === "single", "the worker supervisor to apply single");
    } finally {
      unsubscribe();
      await workerBus.stop();
      await apiBus.stop();
      await Promise.all([workerSql.end({ timeout: 5 }), apiSql.end({ timeout: 5 })]);
    }
  }, 60_000);

  it("heartbeat services built in an api process arm no resweep; a worker's still do", async () => {
    const info = vi.spyOn(logger, "info");
    try {
      // No `executesRuns` passed — the way routes and services build it.
      const apiHeartbeat = heartbeatService(db as never, { runtimeEnv: roleEnv("api") });
      expect(info).toHaveBeenCalledWith({ reason: "process_role" }, RESWEEP_NOT_ARMED);
      await apiHeartbeat.drainActiveRunExecutions();

      info.mockClear();
      const workerHeartbeat = heartbeatService(db as never, { runtimeEnv: roleEnv("worker") });
      expect(info).not.toHaveBeenCalledWith(expect.anything(), RESWEEP_NOT_ARMED);
      await workerHeartbeat.drainActiveRunExecutions(); // stops the armed timer

      // An explicit option still wins over the role.
      info.mockClear();
      const explicit = heartbeatService(db as never, { runtimeEnv: roleEnv("worker"), executesRuns: false });
      expect(info).toHaveBeenCalledWith({ reason: "process_role" }, RESWEEP_NOT_ARMED);
      await explicit.drainActiveRunExecutions();
    } finally {
      info.mockRestore();
    }
  }, 120_000);
});
