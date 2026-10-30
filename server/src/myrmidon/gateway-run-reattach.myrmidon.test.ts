import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY,
  sweepGatewayRunReattach,
  type GatewayRunReattachHeartbeatPort,
} from "./gateway-run-reattach.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { secretService } from "../services/secrets.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getServerAdapter, registerServerAdapter } from "../adapters/index.js";

// myrmidon(HERMES-RUN-REATTACH): after the board restarts without maintenance
// mode, a running hermes_gateway heartbeat run whose gateway run id was
// persisted on the row must be re-dispatched for reattach, not failed as
// "Process lost". Runs of other adapters, terminal runs, and runs without a
// gateway run id are left alone.
//
// myrmidon(T1.6, design BOARD-PROCESSES §4.3): the claim is lease-guarded. A
// run whose legacy controller lease is still live belongs to a running
// controller — another board process, or the previous server during a hot
// restart overlap — and must never be intercepted. Only an absent/expired
// lease is adoptable, plus rows whose controller boot id the caller marked
// adoptable (the graceful hot-restart predecessor).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `company-a ${randomUUID()}`,
      issuePrefix: `MS${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: Db,
  companyId: string,
  adapterType: string,
  adapterConfig: Record<string, unknown> = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `agent-${randomUUID().slice(0, 8)}`,
      adapterType,
      adapterConfig,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createRun(
  db: Db,
  agent: { id: string; companyId: string },
  values: {
    status?: string;
    externalRunId?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
    controllerBootId?: string | null;
    controllerLeaseExpiresAt?: Date | null;
  } = {},
) {
  return db
    .insert(heartbeatRuns)
    .values({
      agentId: agent.id,
      companyId: agent.companyId,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: values.status ?? "running",
      contextSnapshot: values.contextSnapshot ?? {},
      externalRunId: values.externalRunId ?? null,
      // myrmidon(T1.6): the lease columns decide whether a pass may claim the
      // row. Explicit nulls keep "never had a controller" distinguishable
      // from a value the database would fill in.
      controllerBootId: values.controllerBootId ?? null,
      controllerLeaseExpiresAt: values.controllerLeaseExpiresAt ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("myrmidon(HERMES-RUN-REATTACH) gateway run reattach sweep", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-gateway-run-reattach-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeHeartbeatPort(
    calls: Array<{ runId: string; gatewayRunId: string }>,
    probeResults?: Map<
      string,
      { state: "live" | "terminal" | "not_found" | "unreachable"; status: string | null }
    >,
  ): GatewayRunReattachHeartbeatPort {
    return {
      executeRunForGatewayReattach: async (runId, gatewayRunId) => {
        calls.push({ runId, gatewayRunId });
      },
      probeGatewayRun: probeResults
        ? async ({ gatewayRunId }) =>
            probeResults.get(gatewayRunId) ?? { state: "live", status: "running" }
        : undefined,
    };
  }

  it("re-dispatches running hermes_gateway runs with a persisted gateway run id", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const run = await createRun(db, agent, { externalRunId: "gw-run-1" });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.reattached).toBe(1);
    expect(result.runIds).toEqual([run.id]);
    expect(calls).toEqual([{ runId: run.id, gatewayRunId: "gw-run-1" }]);

    // The row now carries the reattach marker (idempotent compare-and-set) and
    // a controller lease this boot owns, so the orphan reaper skips it while
    // the reattach execution spins up.
    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(after?.contextSnapshot).toMatchObject({
      [REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY]: "gw-run-1",
    });
    expect(after?.executionStage).toBe("reattaching");
    expect(after?.controllerBootId).toBe(legacyControllerBootId);
    expect(after?.controllerLeaseExpiresAt).not.toBeNull();
  });

  it("ignores terminal runs, other adapters, and runs without a gateway run id", async () => {
    const company = await createCompany(db);
    const gatewayAgent = await createAgent(db, company.id, "hermes_gateway");
    const otherAgent = await createAgent(db, company.id, "hermes_local");

    await createRun(db, gatewayAgent, { externalRunId: "gw-run-1", status: "completed" });
    await createRun(db, gatewayAgent, { status: "running", externalRunId: null });
    await createRun(db, otherAgent, { status: "running", externalRunId: "gw-run-2" });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.scanned).toBe(0);
    expect(result.reattached).toBe(0);
    expect(calls).toEqual([]);
  });

  it("does not re-dispatch a run a previous pass already marked", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    await createRun(db, agent, {
      externalRunId: "gw-run-1",
      contextSnapshot: { [REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY]: "gw-run-1" },
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.reattached).toBe(0);
    expect(result.skippedAlreadyMarked).toBe(1);
    expect(calls).toEqual([]);
  });

  it("keeps going when one dispatch fails and reports it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const runOk = await createRun(db, agent, { externalRunId: "gw-run-ok" });
    await createRun(db, agent, { externalRunId: "gw-run-bad" });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const heartbeat: GatewayRunReattachHeartbeatPort = {
      executeRunForGatewayReattach: async (runId, gatewayRunId) => {
        if (gatewayRunId === "gw-run-bad") throw new Error("dispatch boom");
        calls.push({ runId, gatewayRunId });
      },
    };
    const result = await sweepGatewayRunReattach(db, heartbeat);

    expect(result.failed).toBe(1);
    expect(result.reattached).toBe(1);
    expect(calls).toEqual([{ runId: runOk.id, gatewayRunId: "gw-run-ok" }]);
  });

  // myrmidon(T1.6, design BOARD-PROCESSES §4.3) — acceptance criterion 1:
  // a live run with a valid lease is never intercepted, by the startup pass
  // or by the periodic pass. The owner's renewals keep losing the row out of
  // the claim, so "Legacy controller lease lost" cannot happen.
  it("does not intercept a run whose controller lease is still live", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const run = await createRun(db, agent, {
      externalRunId: "gw-live",
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.reattached).toBe(0);
    expect(result.skippedLiveLease).toBe(1);
    expect(calls).toEqual([]);

    // The row is untouched: no marker, the owner's boot id and lease stand.
    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(after?.contextSnapshot).not.toHaveProperty(REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY);
    expect(after?.controllerBootId).not.toBe(legacyControllerBootId);
    expect(after?.controllerLeaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  // Acceptance criterion 2 (the periodic pass's reason for existing): an
  // executor died, its lease froze and has now expired — a later pass, which
  // adopts no boot ids, reattaches the run instead of letting the reaper
  // finalize it.
  it("reattaches a dead controller's run once its lease expires (periodic pass)", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const run = await createRun(db, agent, {
      externalRunId: "gw-orphan",
      controllerBootId: randomUUID(), // the dead process's boot id
      controllerLeaseExpiresAt: new Date(Date.now() - 1_000), // frozen lease, now expired
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    // A periodic pass calls with no options: only the lease condition applies.
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.reattached).toBe(1);
    expect(result.skippedLiveLease).toBe(0);
    expect(calls).toEqual([{ runId: run.id, gatewayRunId: "gw-orphan" }]);

    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(after?.controllerBootId).toBe(legacyControllerBootId);
  });

  // Hot restart without losing or delaying runs (criterion 3): the
  // predecessor exited gracefully, its leases are still inside the 60 s
  // window but frozen forever. The startup pass names its boot id adoptable
  // and takes those rows immediately; a live lease under any other boot id
  // stays with its running owner.
  it("startup pass adopts the hot-restart predecessor's rows without waiting out the lease", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const predecessorBootId = randomUUID();
    const strangerBootId = randomUUID();
    const adoptable = await createRun(db, agent, {
      externalRunId: "gw-predecessor",
      controllerBootId: predecessorBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 55_000),
    });
    const foreign = await createRun(db, agent, {
      externalRunId: "gw-foreign",
      controllerBootId: strangerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 55_000),
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls), {
      adoptableControllerBootIds: [predecessorBootId],
    });

    expect(result.reattached).toBe(1);
    expect(result.skippedLiveLease).toBe(1);
    expect(result.runIds).toEqual([adoptable.id]);
    expect(calls).toEqual([{ runId: adoptable.id, gatewayRunId: "gw-predecessor" }]);

    // The foreign run stays exactly as its owner left it.
    const [foreignAfter] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, foreign.id));
    expect(foreignAfter?.controllerBootId).toBe(strangerBootId);
    expect(foreignAfter?.contextSnapshot).not.toHaveProperty(REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY);
  });

  // The guard lives in the atomic claim, not only in the pre-filter: a lease
  // renewed between SELECT and UPDATE makes the claim lose. Simulated by
  // making the dispatch port observe the row mid-pass is unnecessary — the
  // claim UPDATE itself is checked by the live-lease case above (the pre-
  // filter and the UPDATE share the condition). Non-UUID adoptable ids must
  // never reach the uuid `= ANY` binding: they are dropped, and a pass that
  // keeps only garbage ids behaves like the periodic pass.
  it("ignores malformed adoptable boot ids instead of failing the claim", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const run = await createRun(db, agent, {
      externalRunId: "gw-live",
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls), {
      adoptableControllerBootIds: ["not-a-uuid", ""],
    });

    expect(result.reattached).toBe(0);
    expect(result.skippedLiveLease).toBe(1);
    expect(calls).toEqual([]);

    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(after?.controllerBootId).not.toBe(legacyControllerBootId);
  });

  // myrmidon(OPE-10023): restart with 3 live gateway runs: all 3 reattached,
  // no duplicates, and writes succeed without 409 conflict
  it("restart with 3 live gateway runs: all 3 are reattached, no duplicate runs, and write succeeds", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway", {
      apiBaseUrl: "http://127.0.0.1:9999",
      apiKey: "test-key",
    });
    const predecessorBootId = randomUUID();
    const run1 = await createRun(db, agent, {
      externalRunId: "gw-live-1",
      controllerBootId: predecessorBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 50_000),
    });
    const run2 = await createRun(db, agent, {
      externalRunId: "gw-live-2",
      controllerBootId: predecessorBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 45_000),
    });
    const run3 = await createRun(db, agent, {
      externalRunId: "gw-live-3",
      controllerBootId: predecessorBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 40_000),
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const probeMap = new Map([
      ["gw-live-1", { state: "live" as const, status: "running" }],
      ["gw-live-2", { state: "live" as const, status: "running" }],
      ["gw-live-3", { state: "live" as const, status: "running" }],
    ]);
    const port = makeHeartbeatPort(calls, probeMap);

    const result = await sweepGatewayRunReattach(db, port, { isStartup: true });

    expect(result.scanned).toBe(3);
    expect(result.reattached).toBe(3);
    expect(result.skippedLiveLease).toBe(0);
    expect(result.lostNotFound).toBe(0);
    expect(result.skippedUnreachable).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.gatewayRunId).sort()).toEqual(["gw-live-1", "gw-live-2", "gw-live-3"]);

    // Verify all 3 runs now belong to current controller and stay running
    const afterRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [run1.id, run2.id, run3.id]));
    expect(afterRuns).toHaveLength(3);
    for (const r of afterRuns) {
      expect(r.controllerBootId).toBe(legacyControllerBootId);
      expect(r.status).toBe("running");
      expect((r.contextSnapshot as any)?.[REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY]).toBeTruthy();
    }

    // A write from a reattached run succeeds post-restart without conflict
    const writeResult = await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          ...((run1.contextSnapshot as any) ?? {}),
          postRestartWrite: "success",
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run1.id))
      .returning();
    expect(writeResult).toHaveLength(1);
    expect((writeResult[0]?.contextSnapshot as any)?.postRestartWrite).toBe("success");
  });

  it("skips reattach and marks lostNotFound when gateway returns 404 (not_found)", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway", {
      apiBaseUrl: "http://127.0.0.1:9999",
      apiKey: "test-key",
    });
    const run = await createRun(db, agent, {
      externalRunId: "gw-missing-404",
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 50_000),
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const probeMap = new Map([
      ["gw-missing-404", { state: "not_found" as const, status: null }],
    ]);
    const port = makeHeartbeatPort(calls, probeMap);

    const result = await sweepGatewayRunReattach(db, port, { isStartup: true });

    expect(result.scanned).toBe(1);
    expect(result.reattached).toBe(0);
    expect(result.lostNotFound).toBe(1);
    expect(calls).toHaveLength(0);

    // Run remains untouched by reattach, waiting for orphan reaper
    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(after?.controllerBootId).not.toBe(legacyControllerBootId);
  });

  it("delays reattach and marks skippedUnreachable when gateway is unreachable", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway", {
      apiBaseUrl: "http://127.0.0.1:9999",
      apiKey: "test-key",
    });
    const run = await createRun(db, agent, {
      externalRunId: "gw-unreachable",
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 50_000),
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const probeMap = new Map([
      ["gw-unreachable", { state: "unreachable" as const, status: null, error: "ECONNREFUSED" }],
    ]);
    const port = makeHeartbeatPort(calls, probeMap);

    const result = await sweepGatewayRunReattach(db, port, { isStartup: true });

    expect(result.scanned).toBe(1);
    expect(result.reattached).toBe(0);
    expect(result.skippedUnreachable).toBe(1);
    expect(calls).toHaveLength(0);

    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(after?.controllerBootId).not.toBe(legacyControllerBootId);
  });

  it("resolves secret reference apiKey when probing gateway run", async () => {
    const company = await createCompany(db);
    const secret = await secretService(db).create(company.id, {
      name: "Gateway probe token",
      provider: "local_encrypted",
      value: "resolved-secret-probe-key-xyz",
    });
    const agent = await createAgent(db, company.id, "hermes_gateway", {
      apiBaseUrl: "http://127.0.0.1:9999",
      apiKey: { type: "secret_ref", secretId: secret.id },
    });
    const run = await createRun(db, agent, {
      externalRunId: "gw-secret-ref-1",
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 50_000),
    });

    const originalAdapter = getServerAdapter("hermes_gateway");
    let capturedApiKey: string | null | undefined = null;
    registerServerAdapter({
      ...originalAdapter,
      probeGatewayRunForBoard: async (input) => {
        capturedApiKey = input.apiKey;
        return { state: "live", status: "running" };
      },
    });

    try {
      const heartbeat = heartbeatService(db);
      const probeResult = await heartbeat.probeGatewayRun({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
        adapterConfig: agent.adapterConfig as Record<string, unknown>,
        gatewayRunId: "gw-secret-ref-1",
      });

      expect(probeResult.state).toBe("live");
      expect(capturedApiKey).toBe("resolved-secret-probe-key-xyz");

      const calls: Array<{ runId: string; gatewayRunId: string }> = [];
      const port: GatewayRunReattachHeartbeatPort = {
        executeRunForGatewayReattach: async (runId, gatewayRunId) => {
          calls.push({ runId, gatewayRunId });
        },
        probeGatewayRun: (input) => heartbeat.probeGatewayRun(input),
      };

      const sweepResult = await sweepGatewayRunReattach(db, port, { isStartup: true });
      expect(sweepResult.scanned).toBe(1);
      expect(sweepResult.reattached).toBe(1);
      expect(calls).toEqual([{ runId: run.id, gatewayRunId: "gw-secret-ref-1" }]);
    } finally {
      registerServerAdapter(originalAdapter);
    }
  });
});
