import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, instanceSettings } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// myrmidon(PROCS-Q5): vitest forks reuse workers across files in a shard
// (isolate resets modules, not process env), so these assignments must be
// reverted after this file: the settings service reads PAPERCLIP_HOME /
// PAPERCLIP_INSTANCE_ID at import time, and a leaked value shifts other
// files' behavior (e.g. heartbeat-workspace-branch-containment derives
// worktree containment from the same env).
const hoistedEnv = vi.hoisted(() => {
  const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_LOG_DIR", "PAPERCLIP_IN_WORKTREE"] as const;
  const backup: Record<(typeof keys)[number], string | undefined> = {} as Record<(typeof keys)[number], string | undefined>;
  for (const key of keys) backup[key] = process.env[key];
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  return { keys, backup };
});

afterAll(() => {
  for (const key of hoistedEnv.keys) {
    const value = hoistedEnv.backup[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// The singleton row's key, mirroring DEFAULT_SINGLETON_KEY in the service.
const DEFAULT_SINGLETON_KEY = "default";

/**
 * myrmidon(PROCS-Q5): one PATCH per settings field against the SAME singleton
 * row — 27 general fields + 23 experimental flags = 50 concurrent single-field
 * writes. Before the row lock, every writer read-modify-wrote the whole
 * document without serialization, so the last commit rewrote a merge of a
 * stale read and silently lost earlier edits. Each patched value is
 * deliberately different from its default so a lost edit cannot hide behind
 * normalization.
 */
const GENERAL_PATCHES: Array<{ field: string; patch: Record<string, unknown> }> = [
  { field: "censorUsernameInLogs", patch: { censorUsernameInLogs: true } },
  { field: "keyboardShortcuts", patch: { keyboardShortcuts: true } },
  { field: "feedbackDataSharingPreference", patch: { feedbackDataSharingPreference: "allowed" } },
  { field: "backupRetention", patch: { backupRetention: { dailyDays: 3, weeklyWeeks: 1, monthlyMonths: 6 } } },
  { field: "executionMode", patch: { executionMode: "any" } },
  { field: "workspaceHygiene", patch: { workspaceHygiene: { workspaceQuotaMb: 4096, totalQuotaMb: 8192 } } },
  {
    field: "runLimits",
    patch: {
      runLimits: {
        maxConcurrentRuns: 5,
        maxStartsPerMinute: 2,
        minFreeMemoryMb: 512,
        runMemoryEstimateMb: 768,
        minFreeHostMemoryMb: 1024,
        maxHostLoadPercentPerCore: 80,
        maxPerAgentStartSharePercent: 40,
      },
    },
  },
  { field: "hostDisk", patch: { hostDisk: { usageThresholdPercent: 77 } } },
  { field: "botDisk", patch: { botDisk: { enabled: true } } },
  { field: "botDiskQuota", patch: { botDiskQuota: { defaultQuotaMb: 2048 } } },
  { field: "myrmidonBotImageRollout", patch: { myrmidonBotImageRollout: { botTimeoutSec: 120, batchSize: 3, busySoftPauseSec: 5 } } },
  { field: "parallelHelpers", patch: { parallelHelpers: { maxPerAgent: 4, defaultMaxPerAgent: 3, buildSlots: 2, hostMemoryMb: 4096 } } },
  {
    field: "botLsp",
    patch: {
      botLsp: {
        codingRoles: ["engineer"],
        codingMode: "full",
        nonCodingMode: "limited",
        idleTimeoutSeconds: 300,
        tsserverMemoryMb: 2048,
        excludeRoots: ["/tmp/vendor"],
      },
    },
  },
  { field: "browserBridge", patch: { browserBridge: { domains: ["example.com"] } } },
  {
    field: "swarm",
    patch: {
      swarm: {
        enabled: true,
        leaseTtlSec: 600,
        maxActiveTasks: 5,
        sweepIntervalSec: 15,
        p0Preemption: false,
      },
    },
  },
  { field: "swarmClaimJournal", patch: { swarmClaimJournal: [] } },
  { field: "wipLimit", patch: { wipLimit: { defaultLimit: 4 } } },
  { field: "reviewRouting", patch: { reviewRouting: { enabled: true, maxLoadPerReviewer: 7, reassignAfterHours: 48 } } },
  { field: "reviewRework", patch: { reviewRework: { enabled: false } } },
  { field: "reviewReworkJournal", patch: { reviewReworkJournal: [] } },
  { field: "budgetEnforcement", patch: { budgetEnforcement: { mode: "soft" } } },
  { field: "pluginEntitlementKeys", patch: { pluginEntitlementKeys: [] } },
  { field: "telegramDmProgress", patch: { telegramDmProgress: { enabled: true, intervalSec: 30 } } },
  { field: "agentMemory", patch: { agentMemory: { enabled: true, apiUrl: "http://127.0.0.1:1/agentmem", keySecretName: "agent-mem-key" } } },
  {
    field: "teamLiveness",
    patch: {
      teamLiveness: {
        autoResumeEnabled: false,
        runStallEnabled: false,
        runStallThresholdSec: 400,
        idlePickupEnabled: false,
        idlePickupIntervalSec: 70,
        idlePickupWakeBudgetPerMin: 9,
        idlePickupWakeBatch: 3,
      },
    },
  },
  { field: "promptBudget", patch: { promptBudget: { warnPct: 60, critPct: 80, enabled: true, fallbackWindowTokens: 300000 } } },
  { field: "modelFallbackSignal", patch: { modelFallbackSignal: { enabled: true, thresholdPct: 45, minCalls: 30, windowSec: 600, intervalSec: 120 } } },
];

const EXPERIMENTAL_PATCHES: Array<{ field: string; value: boolean }> = [
  { field: "enableEnvironments", value: true },
  { field: "enableNativeRunner", value: false },
  { field: "enableManagedSandboxOnly", value: true },
  { field: "enableIsolatedWorkspaces", value: true },
  { field: "enableIsolatedWorkspacesByDefault", value: true },
  { field: "enableStreamlinedLeftNavigation", value: false },
  { field: "enableStreamlinedUi", value: false },
  { field: "enableChatConnectors", value: true },
  { field: "enablePipelines", value: true },
  { field: "enableCases", value: true },
  { field: "enableAgentChat", value: true },
  { field: "enableConferenceRoomChat", value: true },
  { field: "enableClassicTaskInterface", value: true },
  { field: "enableIssuePlanDecompositions", value: true },
  { field: "enableExperimentalFileViewer", value: true },
  { field: "enableExternalObjects", value: true },
  { field: "enableSmokeLab", value: true },
  { field: "enableBuiltInAgents", value: true },
  { field: "enableBetaSkills", value: true },
  { field: "enableSummaries", value: true },
  { field: "enableStatusCards", value: true },
  { field: "enableDecisions", value: true },
  { field: "enableMyrmidonUi2", value: true },
];

// Subsets of the patched values (schemas fill defaults, so the stored
// document can carry more keys than the patch — every key listed here must
// survive regardless of what the 49 other concurrent writers committed).
const GENERAL_EXPECTATIONS: Record<string, unknown> = {
  censorUsernameInLogs: true,
  keyboardShortcuts: true,
  feedbackDataSharingPreference: "allowed",
  backupRetention: { dailyDays: 3, weeklyWeeks: 1, monthlyMonths: 6 },
  workspaceHygiene: { workspaceQuotaMb: 4096, totalQuotaMb: 8192 },
  runLimits: { maxConcurrentRuns: 5, maxStartsPerMinute: 2, minFreeMemoryMb: 512, runMemoryEstimateMb: 768 },
  hostDisk: { usageThresholdPercent: 77 },
  botDisk: { enabled: true },
  botDiskQuota: { defaultQuotaMb: 2048 },
  myrmidonBotImageRollout: { botTimeoutSec: 120, batchSize: 3, busySoftPauseSec: 5 },
  parallelHelpers: { maxPerAgent: 4, defaultMaxPerAgent: 3, buildSlots: 2, hostMemoryMb: 4096 },
  botLsp: { codingRoles: ["engineer"], codingMode: "full", nonCodingMode: "limited", idleTimeoutSeconds: 300, tsserverMemoryMb: 2048 },
  browserBridge: { domains: ["example.com"] },
  swarm: { enabled: true, leaseTtlSec: 600, maxActiveTasks: 5, sweepIntervalSec: 15, p0Preemption: false },
  swarmClaimJournal: [],
  wipLimit: { defaultLimit: 4 },
  reviewRouting: { enabled: true, maxLoadPerReviewer: 7, reassignAfterHours: 48 },
  reviewRework: { enabled: false },
  reviewReworkJournal: [],
  budgetEnforcement: { mode: "soft" },
  pluginEntitlementKeys: [],
  telegramDmProgress: { enabled: true, intervalSec: 30 },
  agentMemory: { enabled: true, apiUrl: "http://127.0.0.1:1/agentmem", keySecretName: "agent-mem-key" },
  teamLiveness: { autoResumeEnabled: false, runStallEnabled: false, runStallThresholdSec: 400, idlePickupEnabled: false, idlePickupIntervalSec: 70, idlePickupWakeBudgetPerMin: 9, idlePickupWakeBatch: 3 },
  promptBudget: { warnPct: 60, critPct: 80, enabled: true, fallbackWindowTokens: 300000 },
  modelFallbackSignal: { enabled: true, thresholdPct: 45, minCalls: 30, windowSec: 600, intervalSec: 120 },
};

async function createApp(db: Db) {
  const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/instance-settings.js"),
  ]);
  const userId = `owner-${randomUUID()}`;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [],
      memberships: [],
    };
    next();
  });
  app.use("/api", instanceSettingsRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("instance settings concurrent PATCH keeps every edit (PROCS-Q5)", () => {
  let db!: Db;
  let app!: express.Express;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Load the route graph once during setup so a cold CI transform does not
  // eat the first request's timeout budget (same pattern as the other
  // embedded-Postgres route suites).
  beforeAll(async () => {
    await import("../routes/instance-settings.js");
  }, 60_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instance-settings-lock-");
    db = createDb(tempDb.connectionString);
    app = await createApp(db);
    // Seed the singleton row through the API so the 50 racing writers never
    // race the first-writer insert path (the lock covers that path too, but
    // the acceptance criterion is about losing edits between PATCHes).
    const seeded = await request(app).get("/api/instance/settings/general");
    expect(seeded.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps all 50 concurrent single-field PATCHes (27 general + 23 experimental)", async () => {
    const requests = [
      ...GENERAL_PATCHES.map((entry) => request(app).patch("/api/instance/settings/general").send(entry.patch)),
      ...EXPERIMENTAL_PATCHES.map((entry) =>
        request(app).patch("/api/instance/settings/experimental").send({ [entry.field]: entry.value }),
      ),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    const generalRes = await request(app).get("/api/instance/settings/general");
    expect(generalRes.status).toBe(200);
    const general = generalRes.body as Record<string, unknown>;
    for (const [field, expected] of Object.entries(GENERAL_EXPECTATIONS)) {
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        expect(general[field], `general.${field} lost a concurrent edit`).toMatchObject(expected as object);
      } else {
        expect(general[field], `general.${field} lost a concurrent edit`).toEqual(expected);
      }
    }
    // Absent and "any" both mean "unrestricted"; the schema keeps the value
    // optional, so only assert the field did not come back as something else.
    expect(general.executionMode ?? "any").toBe("any");

    const experimentalRes = await request(app).get("/api/instance/settings/experimental");
    expect(experimentalRes.status).toBe(200);
    const experimental = experimentalRes.body as Record<string, unknown>;
    for (const entry of EXPERIMENTAL_PATCHES) {
      expect(experimental[entry.field], `experimental.${entry.field} lost a concurrent edit`).toBe(entry.value);
    }

    // The stored document itself — not just the GET normalization — holds
    // every value: a lost write would show up in the row.
    const [row] = await db
      .select({ general: instanceSettings.general, experimental: instanceSettings.experimental })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .limit(1);
    expect(row).toBeDefined();
    const storedGeneral = row!.general as Record<string, unknown>;
    expect(storedGeneral.censorUsernameInLogs).toBe(true);
    expect(storedGeneral.modelFallbackSignal).toMatchObject({ thresholdPct: 45 });
    expect(storedGeneral.teamLiveness).toMatchObject({ runStallThresholdSec: 400 });
    const storedExperimental = row!.experimental as Record<string, unknown>;
    for (const entry of EXPERIMENTAL_PATCHES) {
      expect(storedExperimental[entry.field]).toBe(entry.value);
    }
  }, 120_000);

  it("keeps sequential PATCH behavior unchanged", async () => {
    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: false, keyboardShortcuts: false });
    expect(res.status).toBe(200);
    expect(res.body.censorUsernameInLogs).toBe(false);
    expect(res.body.keyboardShortcuts).toBe(false);
    // Fields written by the 50-way race above keep their stored values.
    expect(res.body.budgetEnforcement).toMatchObject({ mode: "soft" });
    // Validation is unchanged: an unknown strict key is still rejected.
    const invalid = await request(app).patch("/api/instance/settings/general").send({ unknownField: 1 });
    expect(invalid.status).toBe(400);
  }, 30_000);
});
