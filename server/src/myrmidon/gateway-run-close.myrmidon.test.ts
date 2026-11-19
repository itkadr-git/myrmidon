import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { reconcileAbandonedExecutionControl } from "../services/execution-control-reconciliation.js";
import { getServerAdapter, registerServerAdapter } from "../adapters/index.js";
import {
  GATEWAY_REMOTE_CLOSE_DONE_EVENT,
  GATEWAY_REMOTE_CLOSE_FAILED_EVENT,
  GATEWAY_REMOTE_CLOSE_MAX_ATTEMPTS,
  GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
  GATEWAY_REMOTE_CLOSE_LOOKBACK_MS,
} from "./gateway-run-close.js";

// myrmidon(HERMES-GATEWAY-CLOSE, OPE-11889): the remote hermes gateway run of a
// heartbeat run that the board has finished with is closed -- on a board-side
// timeout and on every terminal status, not only on an operator cancellation --
// exactly once, with provenance, and without touching what a retry of the run
// continues from (the run record and the Hermes session).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type ProbeState = "live" | "terminal" | "not_found" | "unreachable";

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `company-close ${randomUUID()}`,
      issuePrefix: `GC${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, adapterType = "hermes_gateway") {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `agent-${randomUUID().slice(0, 8)}`,
      adapterType,
      adapterConfig: { apiBaseUrl: "http://127.0.0.1:9999", apiKey: "test-key" },
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createRun(
  db: Db,
  agent: { id: string; companyId: string },
  values: Partial<typeof heartbeatRuns.$inferInsert> = {},
) {
  return db
    .insert(heartbeatRuns)
    .values({
      agentId: agent.id,
      companyId: agent.companyId,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "running",
      contextSnapshot: {},
      controllerBootId: null,
      controllerLeaseExpiresAt: null,
      ...values,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("myrmidon(HERMES-GATEWAY-CLOSE) close the gateway run of a finished heartbeat run", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalAdapter = getServerAdapter("hermes_gateway");

  // What the mocked gateway does: the state a probe reports per gateway run id,
  // and every stop / probe the board sent.
  let probeStates: Map<string, ProbeState>;
  let probes: string[];
  let stops: Array<{
    gatewayRunId: string;
    apiKey: string;
    cancellation?: { correlationId: string; source: { code: string; endpoint?: string; actor?: string }; reason: string };
  }>;
  let stopResult: boolean;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-gateway-run-close-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    probeStates = new Map();
    probes = [];
    stops = [];
    stopResult = true;
    registerServerAdapter({
      ...originalAdapter,
      probeGatewayRunForBoard: async (input) => {
        probes.push(input.gatewayRunId);
        const state = probeStates.get(input.gatewayRunId) ?? "live";
        return {
          state,
          status: state === "live" ? "running" : state === "terminal" ? "completed" : null,
          ...(state === "unreachable" ? { error: "ECONNREFUSED" } : {}),
        };
      },
      stopGatewayRunForBoard: async (input) => {
        stops.push({
          gatewayRunId: input.gatewayRunId,
          apiKey: input.apiKey,
          cancellation: input.cancellation,
        });
        return { stopped: stopResult };
      },
    });
  });

  afterEach(async () => {
    registerServerAdapter(originalAdapter);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function ledger(runId: string) {
    return db
      .select()
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.runId, runId),
          inArray(heartbeatRunEvents.eventType, [
            GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
            GATEWAY_REMOTE_CLOSE_DONE_EVENT,
            GATEWAY_REMOTE_CLOSE_FAILED_EVENT,
          ]),
        ),
      )
      .orderBy(asc(heartbeatRunEvents.id));
  }

  /** Make the close attempts of a run old enough to be retried. */
  async function ageLedger(runId: string, minutes = 10) {
    await db.execute(
      sql`update heartbeat_run_events set created_at = created_at - make_interval(mins => ${minutes})
          where run_id = ${runId} and event_type like 'gateway_remote_close%'`,
    );
  }

  /** The background close started by a status writer settles on its own; wait for its verdict. */
  async function waitForVerdict(runId: string) {
    await vi.waitFor(
      async () => {
        const events = await ledger(runId);
        expect(
          events.some(
            (event) =>
              event.eventType === GATEWAY_REMOTE_CLOSE_DONE_EVENT ||
              event.eventType === GATEWAY_REMOTE_CLOSE_FAILED_EVENT,
          ),
        ).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
  }

  it("a board-side timeout (the execution-control deadline) stops the live gateway run once, with provenance", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, agent, {
      externalRunId: "gw-board-timeout",
      executionControlDeadlineAt: new Date(Date.now() - 60_000),
    });
    const heartbeat = heartbeatService(db);

    const closes: Array<Promise<unknown>> = [];
    await reconcileAbandonedExecutionControl(db, new Date(), {
      onTerminalRun: (failed) => closes.push(heartbeat.closeTerminalGatewayRun(failed.id)),
    });
    await Promise.all(closes);

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("execution_finalization_deadline_exceeded");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      gatewayRunId: "gw-board-timeout",
      apiKey: "test-key",
      cancellation: {
        source: { code: "board_timeout", actor: "board" },
        reason: expect.stringContaining(run.id),
      },
    });
    expect(stops[0]!.cancellation!.correlationId).toMatch(/^[0-9a-f-]{36}$/);

    // Provenance is on the run: who closed it, why, and what the gateway said.
    const events = await ledger(run.id);
    expect(events.map((event) => event.eventType)).toEqual([
      GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
      GATEWAY_REMOTE_CLOSE_DONE_EVENT,
    ]);
    expect(events[1]?.payload).toMatchObject({
      outcome: "stopped",
      trigger: "terminal",
      attempt: 1,
      gatewayRunId: "gw-board-timeout",
      correlationId: stops[0]!.cancellation!.correlationId,
      source: { code: "board_timeout", actor: "board" },
    });

    // Once: asking again, from the same path or from the sweep, sends nothing.
    await expect(heartbeat.closeTerminalGatewayRun(run.id)).resolves.toEqual({
      outcome: "skipped",
      reason: "already_closed",
    });
    await heartbeat.sweepTerminalGatewayRunCloses();
    expect(stops).toHaveLength(1);
    expect(await ledger(run.id)).toHaveLength(2);
  });

  it("the sweep closes the gateway run of every terminal status, whoever wrote it, and stops only a live one", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const heartbeat = heartbeatService(db);
    const failedStale = await createRun(db, agent, {
      status: "failed", errorCode: "process_lost", externalRunId: "gw-failed", finishedAt: new Date(),
    });
    const timedOut = await createRun(db, agent, {
      status: "timed_out", errorCode: "timeout", externalRunId: "gw-timed-out", finishedAt: new Date(),
    });
    const cancelled = await createRun(db, agent, {
      status: "cancelled", errorCode: "cancelled", externalRunId: "gw-cancelled", finishedAt: new Date(),
    });
    const interrupted = await createRun(db, agent, {
      status: "interrupted", externalRunId: "gw-interrupted", finishedAt: new Date(),
    });
    const adapterFailed = await createRun(db, agent, {
      status: "failed", errorCode: "adapter_failed", externalRunId: "gw-adapter-failed", finishedAt: new Date(),
    });
    // The success path: the gateway already finished this run, so there is no slot to free.
    const succeeded = await createRun(db, agent, {
      status: "succeeded", externalRunId: "gw-succeeded", finishedAt: new Date(),
    });
    probeStates.set("gw-succeeded", "terminal");

    // Not candidates: a non-gateway agent, a run that never reached the gateway,
    // a run still running, a run older than the sweep window.
    const otherAgent = await createAgent(db, company.id, "claude_local");
    const otherAdapter = await createRun(db, otherAgent, {
      status: "failed", externalRunId: "gw-other-adapter", finishedAt: new Date(),
    });
    const neverAdmitted = await createRun(db, agent, { status: "failed", externalRunId: null, finishedAt: new Date() });
    const stillRunning = await createRun(db, agent, { status: "running", externalRunId: "gw-still-running" });
    const tooOld = await createRun(db, agent, {
      status: "failed", externalRunId: "gw-too-old", finishedAt: new Date(),
      updatedAt: new Date(Date.now() - GATEWAY_REMOTE_CLOSE_LOOKBACK_MS - 60_000),
    });

    const swept = await heartbeat.sweepTerminalGatewayRunCloses();

    expect(swept.scanned).toBe(6);
    expect(swept.failed).toBe(0);
    expect(stops.map((stop) => stop.gatewayRunId).sort()).toEqual(
      ["gw-adapter-failed", "gw-cancelled", "gw-failed", "gw-interrupted", "gw-timed-out"],
    );
    const sourceOf = (runId: string) =>
      stops.find((stop) => stop.gatewayRunId === ({
        [failedStale.id]: "gw-failed",
        [timedOut.id]: "gw-timed-out",
        [cancelled.id]: "gw-cancelled",
        [interrupted.id]: "gw-interrupted",
        [adapterFailed.id]: "gw-adapter-failed",
      } as Record<string, string>)[runId])?.cancellation?.source.code;
    expect(sourceOf(failedStale.id)).toBe("board_stale");
    expect(sourceOf(timedOut.id)).toBe("board_timeout");
    expect(sourceOf(cancelled.id)).toBe("board_cancelled");
    expect(sourceOf(interrupted.id)).toBe("terminal_completion");
    expect(sourceOf(adapterFailed.id)).toBe("terminal_completion");

    // The finished gateway run was probed, recorded as already closed, and never stopped.
    expect(probes).toContain("gw-succeeded");
    const succeededEvents = await ledger(succeeded.id);
    expect(succeededEvents.at(-1)).toMatchObject({
      eventType: GATEWAY_REMOTE_CLOSE_DONE_EVENT,
      payload: expect.objectContaining({ outcome: "already_closed", gatewayRunId: "gw-succeeded" }),
    });

    for (const untouched of [otherAdapter, neverAdmitted, stillRunning, tooOld]) {
      expect(await ledger(untouched.id)).toHaveLength(0);
    }
    expect(probes).not.toContain("gw-other-adapter");
    expect(probes).not.toContain("gw-still-running");
    expect(probes).not.toContain("gw-too-old");

    // A second pass is a no-op.
    const stopsBefore = stops.length;
    const probesBefore = probes.length;
    const again = await heartbeat.sweepTerminalGatewayRunCloses();
    expect(again.scanned).toBe(0);
    expect(stops).toHaveLength(stopsBefore);
    expect(probes).toHaveLength(probesBefore);
  });

  it("a run finalized by the board's own status writer closes its gateway run without waiting for the sweep", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, agent, { externalRunId: "gw-site-lost" });
    const heartbeat = heartbeatService(db);

    const finalized = await heartbeat.finalizeSiteLostRun(run.id, "site-a");
    expect(finalized.outcome).toBe("finalized");
    await waitForVerdict(run.id);

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("site_lost");
    expect(stops.map((stop) => stop.gatewayRunId)).toEqual(["gw-site-lost"]);
    const events = await ledger(run.id);
    expect(events.at(-1)?.payload).toMatchObject({ outcome: "stopped", trigger: "terminal" });
  });

  it("an operator cancellation and the terminal write that follows it send the gateway one stop, with the operator's provenance", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, agent, { externalRunId: "gw-operator-cancel" });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(run.id, "Отменено оператором: прогон завис", {
      cancellationSource: { code: "issue_comment_interrupt", endpoint: "POST /api/issues/:id/comments", actor: "user-7" },
      correlationId: "corr-operator-1",
    });
    await heartbeat.sweepTerminalGatewayRunCloses();
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the terminal-write hook settle

    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(cancelled?.status).toBe("cancelled");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      gatewayRunId: "gw-operator-cancel",
      cancellation: {
        correlationId: "corr-operator-1",
        source: { code: "issue_comment_interrupt", actor: "user-7" },
        reason: "Отменено оператором: прогон завис",
      },
    });
    const events = await ledger(run.id);
    expect(events.map((event) => event.eventType)).toEqual([
      GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
      GATEWAY_REMOTE_CLOSE_DONE_EVENT,
    ]);
    expect(events[1]?.payload).toMatchObject({
      trigger: "cancel",
      outcome: "stopped",
      correlationId: "corr-operator-1",
      source: { code: "issue_comment_interrupt", actor: "user-7" },
      reason: "Отменено оператором: прогон завис",
    });
  });

  it("an unreachable gateway is probed again only after the retry delay, and only a bounded number of times", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, agent, {
      status: "failed", errorCode: "process_lost", externalRunId: "gw-unreachable", finishedAt: new Date(),
    });
    probeStates.set("gw-unreachable", "unreachable");
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepTerminalGatewayRunCloses();
    expect(probes).toEqual(["gw-unreachable"]);
    expect(stops).toHaveLength(0);
    expect((await ledger(run.id)).at(-1)).toMatchObject({
      eventType: GATEWAY_REMOTE_CLOSE_FAILED_EVENT,
      payload: expect.objectContaining({ outcome: "unreachable", attempt: 1, detail: "ECONNREFUSED" }),
    });

    // Not due yet: no second probe, whichever path asks.
    await heartbeat.sweepTerminalGatewayRunCloses();
    await expect(heartbeat.closeTerminalGatewayRun(run.id)).resolves.toEqual({
      outcome: "skipped",
      reason: "retry_not_due",
    });
    expect(probes).toHaveLength(1);

    // Due again, and the gateway answers: the run is live and gets stopped.
    await ageLedger(run.id);
    probeStates.set("gw-unreachable", "live");
    await heartbeat.sweepTerminalGatewayRunCloses();
    expect(stops.map((stop) => stop.gatewayRunId)).toEqual(["gw-unreachable"]);
    expect((await ledger(run.id)).at(-1)).toMatchObject({
      eventType: GATEWAY_REMOTE_CLOSE_DONE_EVENT,
      payload: expect.objectContaining({ outcome: "stopped", attempt: 2 }),
    });

    // A gateway that never answers is given up on after the bound.
    const hopeless = await createRun(db, agent, {
      status: "timed_out", errorCode: "timeout", externalRunId: "gw-hopeless", finishedAt: new Date(),
    });
    probeStates.set("gw-hopeless", "unreachable");
    for (let attempt = 0; attempt < GATEWAY_REMOTE_CLOSE_MAX_ATTEMPTS + 2; attempt += 1) {
      await heartbeat.sweepTerminalGatewayRunCloses();
      await ageLedger(hopeless.id);
    }
    expect(probes.filter((id) => id === "gw-hopeless")).toHaveLength(GATEWAY_REMOTE_CLOSE_MAX_ATTEMPTS);
    expect(stops.map((stop) => stop.gatewayRunId)).not.toContain("gw-hopeless");
  });

  it("a stop the gateway did not accept is recorded and retried, not reported as closed", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, agent, {
      status: "failed", errorCode: "adapter_failed", externalRunId: "gw-stop-refused", finishedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    stopResult = false;
    await heartbeat.sweepTerminalGatewayRunCloses();
    expect(stops).toHaveLength(1);
    expect((await ledger(run.id)).at(-1)).toMatchObject({
      eventType: GATEWAY_REMOTE_CLOSE_FAILED_EVENT,
      payload: expect.objectContaining({ outcome: "stop_failed", attempt: 1 }),
    });

    stopResult = true;
    await ageLedger(run.id);
    await heartbeat.sweepTerminalGatewayRunCloses();
    expect(stops).toHaveLength(2);
    expect((await ledger(run.id)).at(-1)).toMatchObject({
      eventType: GATEWAY_REMOTE_CLOSE_DONE_EVENT,
      payload: expect.objectContaining({ outcome: "stopped", attempt: 2 }),
    });
  });

  it("two paths closing the same run at once send the gateway one stop", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, agent, {
      status: "failed", errorCode: "adapter_failed", externalRunId: "gw-concurrent", finishedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    await Promise.all([
      heartbeat.closeTerminalGatewayRun(run.id),
      heartbeat.closeTerminalGatewayRun(run.id),
      heartbeat.sweepTerminalGatewayRunCloses(),
    ]);

    expect(stops.map((stop) => stop.gatewayRunId)).toEqual(["gw-concurrent"]);
    const events = await ledger(run.id);
    expect(events.map((event) => event.eventType)).toEqual([
      GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
      GATEWAY_REMOTE_CLOSE_DONE_EVENT,
    ]);
  });

  it("closing leaves the run record and the retry of the run untouched", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const failed = await createRun(db, agent, {
      status: "failed",
      errorCode: "process_lost",
      error: "Process lost",
      externalRunId: "gw-before-retry",
      sessionIdBefore: "hermes-session-1",
      sessionIdAfter: "hermes-session-1",
      resultJson: { run_id: "gw-before-retry", summary: "partial work" },
      contextSnapshot: { issueId: randomUUID() },
      finishedAt: new Date(),
    });
    // The retry of the run: same agent, same Hermes session, its own gateway run.
    const retry = await createRun(db, agent, {
      status: "running",
      externalRunId: "gw-retry",
      sessionIdBefore: "hermes-session-1",
      contextSnapshot: { retryOfRunId: failed.id },
    });
    const columns = (row: typeof failed) => ({
      status: row.status,
      error: row.error,
      errorCode: row.errorCode,
      externalRunId: row.externalRunId,
      sessionIdBefore: row.sessionIdBefore,
      sessionIdAfter: row.sessionIdAfter,
      resultJson: row.resultJson,
      contextSnapshot: row.contextSnapshot,
      finishedAt: row.finishedAt,
    });
    const failedBefore = columns(failed);
    const retryBefore = columns(retry);
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepTerminalGatewayRunCloses();

    expect(stops.map((stop) => stop.gatewayRunId)).toEqual(["gw-before-retry"]);
    const [failedAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed.id));
    const [retryAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id));
    expect(columns(failedAfter!)).toEqual(failedBefore);
    expect(columns(retryAfter!)).toEqual(retryBefore);
    expect(await ledger(retry.id)).toHaveLength(0);
  });

  // myrmidon(OPE-12484): a run the lease watcher cancelled carries the real
  // cause in resultJson.executionCancellation; the close must forward that
  // cause instead of the board_cancelled placeholder.
  it("a lease-lost cancellation forwards its recorded cause to the gateway, not board_cancelled", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createRun(db, agent, {
      status: "cancelled",
      errorCode: "cancelled",
      externalRunId: "gw-lease-lost",
      finishedAt: new Date(),
      resultJson: {
        executionCancellation: {
          state: "acknowledged",
          correlationId: "corr-lease-1",
          source: { code: "controller_lease_lost", actor: "system" },
          reason: "Legacy controller lease lost",
        },
      },
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepTerminalGatewayRunCloses();

    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      gatewayRunId: "gw-lease-lost",
      cancellation: {
        correlationId: "corr-lease-1",
        source: { code: "controller_lease_lost", actor: "system" },
        reason: "Legacy controller lease lost",
      },
    });
    const events = await ledger(run.id);
    expect(events.at(-1)?.payload).toMatchObject({
      outcome: "stopped",
      trigger: "sweep",
      source: { code: "controller_lease_lost", actor: "system" },
    });
  });
});
