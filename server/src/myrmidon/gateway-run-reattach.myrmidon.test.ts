import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
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
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `agent-${randomUUID().slice(0, 8)}`,
      adapterType,
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

  function makeHeartbeatPort(calls: Array<{ runId: string; gatewayRunId: string }>): GatewayRunReattachHeartbeatPort {
    return {
      executeRunForGatewayReattach: async (runId, gatewayRunId) => {
        calls.push({ runId, gatewayRunId });
      },
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
});
