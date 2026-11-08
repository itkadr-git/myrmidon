// server/src/myrmidon/litellm-workers/service.ts
//
// myrmidon(1.6.6 LITELLM-WORKERS restart): what a GET reports and what a PUT does.
//
// The whole decision lives here, over four ports (the settings store, the
// gateway read, the declared-workers read, the restart), so both routes are
// thin and the tests run without a database, a container or a restart.
//
// The gateway runs as `litellm --num_workers N`, not under gunicorn, so the
// pool size changes only with a planned restart of its unit: the PUT stores the
// target, runs the configured restart command with `{workers}` = target and
// then CONFIRMS the result itself — `applied` is true only when `current`
// read afterwards equals the target.
//
// Reading the pool size is the delicate part, because the confirmation and the
// "nothing to do" shortcut both rest on it. The size is taken from the most
// trustworthy source that has one, and the answer says which one it was:
//
//   1. the gateway's own pool gauge, when it publishes one;
//   2. the `--num_workers` of the gateway's launch line (the unit file) — what
//      the process was actually started with;
//   3. the per-pid hint of the exposition, which a single scrape usually
//      answers about ONE worker, so it is labelled as the weak source it is;
//   4. the board's record of what it last confirmed;
//   5. the declared baseline (`MYRMIDON_LITELLM_WORKERS_BASELINE`).
//
// With none of the five there is no `current`, and the restart is refused with
// a sentence rather than guessed: the target is stored (it is the operator's
// decision) and the answer says the pool was left alone.

import {
  checkLitellmWorkersTarget,
  litellmWorkersCeilings,
  readLitellmWorkersRuntime,
  renderLitellmWorkersRestartCommand,
  resolveLitellmWorkersTarget,
  type LitellmWorkersCeilings,
  type LitellmWorkersHostShape,
  type LitellmWorkersMetrics,
  type LitellmWorkersStoredSettings,
} from "@myrmidon/shared";
import { badRequest } from "../../errors.js";
import {
  createShellLitellmRestartRunner,
  createUnitFileDeclaredWorkers,
  type LitellmDeclaredWorkersPort,
  type LitellmMetricsRead,
  type LitellmRestartDelivery,
  type LitellmRestartRunner,
  type LitellmWorkersGatewayPort,
} from "./gateway.js";
import { unavailableLitellmWorkersMetrics } from "./metrics.js";
import { inProcessLitellmWorkersLock, type LitellmWorkersLock, type LitellmWorkersStore } from "./settings.js";

/** Where the `current` in an answer came from. */
export type LitellmWorkersCurrentSource =
  | "gateway"
  | "launch_line"
  | "gateway_pids"
  | "last_applied"
  | "baseline"
  | "unknown";

export interface LitellmWorkersDeps {
  store: LitellmWorkersStore;
  env: Record<string, string | undefined>;
  /** The gateway read port; null when no gateway endpoint is configured. */
  gateway: LitellmWorkersGatewayPort | null;
  /** The launch-line read; the unit-file reader of the declared path unless a test passes one. */
  declared?: LitellmDeclaredWorkersPort;
  /** The restart port; the shell runner unless a test passes a recording one. */
  restartRunner?: LitellmRestartRunner;
  /**
   * Serialises whole resizes. The routes pass the database advisory lock; the
   * default is an in-process queue, enough for one process and for the tests.
   */
  lock?: LitellmWorkersLock;
}

/** Everything the card and the API need to say about one company's gateway. */
export interface LitellmWorkersView {
  companyId: string;
  /** The pool size some source reports; null when no source knows it. */
  current: number | null;
  currentSource: LitellmWorkersCurrentSource;
  target: number;
  targetSource: "settings" | "default";
  minTarget: number;
  maxTarget: number;
  maxByCpu: number;
  maxByMemory: number;
  defaultTarget: number;
  host: LitellmWorkersHostShape;
  hostSource: { cores: string; memoryGb: string };
  metrics: LitellmWorkersMetrics;
  metricsSource: "gateway" | "unavailable";
  gateway: { configured: boolean; reachable: boolean; error: string | null; workersSource: string | null };
  /**
   * How a new target is applied: a planned restart of the gateway unit.
   * `interruption` is true because the restart briefly drops requests, which
   * the card says before the operator confirms.
   */
  apply: { path: "restart"; configured: boolean; interruption: boolean };
  observedAt: string | null;
}

/** A resize: what was asked, what was delivered, and the state afterwards. */
export interface LitellmWorkersApplyResult {
  view: LitellmWorkersView;
  /** True only when `current`, read after the restart, equals the target. */
  applied: boolean;
  /** True when the restart command was run. */
  restarted: boolean;
  /** Every command actually run, in order. */
  deliveries: LitellmRestartDelivery[];
  applyError: string | null;
  /** False when the stored target did not change. */
  changed: boolean;
}

/** The size of the pool as one source or another reports it. */
interface LitellmWorkersCurrent {
  workers: number | null;
  source: LitellmWorkersCurrentSource;
}

function resolveCurrent(
  read: LitellmMetricsRead | null,
  declared: number | null,
  stored: LitellmWorkersStoredSettings,
  baseline: number | null,
): LitellmWorkersCurrent {
  if (read !== null && read.ok && read.workersSource === "gauge" && read.workers !== null) {
    return { workers: read.workers, source: "gateway" };
  }
  if (declared !== null) return { workers: declared, source: "launch_line" };
  if (read !== null && read.ok && read.workersSource === "pids" && read.workers !== null) {
    return { workers: read.workers, source: "gateway_pids" };
  }
  if (stored.observed !== null) return { workers: stored.observed.workers, source: "last_applied" };
  if (baseline !== null) return { workers: baseline, source: "baseline" };
  return { workers: null, source: "unknown" };
}

/**
 * Reads the gateway once. A gateway that is not configured is not an error:
 * the endpoint still reports the target, the ceilings and why the live numbers
 * are missing, and only the resize is unavailable.
 */
async function readGateway(deps: LitellmWorkersDeps, companyId: string): Promise<LitellmMetricsRead | null> {
  if (deps.gateway === null) return null;
  return deps.gateway.readMetrics(companyId);
}

async function readDeclared(
  deps: LitellmWorkersDeps,
  runtime: ReturnType<typeof readLitellmWorkersRuntime>,
): Promise<number | null> {
  return (deps.declared ?? createUnitFileDeclaredWorkers(runtime.unitFile)).readDeclaredWorkers();
}

function buildView(input: {
  companyId: string;
  stored: LitellmWorkersStoredSettings;
  ceilings: LitellmWorkersCeilings;
  runtime: ReturnType<typeof readLitellmWorkersRuntime>;
  read: LitellmMetricsRead | null;
  current: LitellmWorkersCurrent;
}): LitellmWorkersView {
  const { companyId, stored, ceilings, runtime, read, current } = input;
  const resolved = resolveLitellmWorkersTarget(stored, ceilings);
  return {
    companyId,
    // Null when no source knows the pool: a made-up number would be shown as
    // a reading. The declared baseline is already a source (`baseline`).
    current: current.workers,
    currentSource: current.source,
    target: resolved.target,
    targetSource: resolved.source,
    minTarget: ceilings.minTarget,
    maxTarget: ceilings.maxTarget,
    maxByCpu: ceilings.maxByCpu,
    maxByMemory: ceilings.maxByMemory,
    defaultTarget: ceilings.defaultTarget,
    host: runtime.host,
    hostSource: { cores: runtime.hostSource.cores, memoryGb: runtime.hostSource.memoryGb },
    metrics: read !== null && read.ok ? read.metrics : unavailableLitellmWorkersMetrics(),
    metricsSource: read !== null && read.ok ? "gateway" : "unavailable",
    gateway: {
      configured: read !== null,
      reachable: read !== null && read.ok,
      error: read !== null && !read.ok ? read.error : null,
      workersSource: read !== null && read.ok ? read.workersSource : null,
    },
    apply: { path: "restart", configured: runtime.restart.command !== null, interruption: true },
    observedAt: stored.observed?.at ?? null,
  };
}

/** The state of one company's gateway, as the GET answers it. */
export async function readLitellmWorkersView(
  deps: LitellmWorkersDeps,
  companyId: string,
): Promise<LitellmWorkersView> {
  const runtime = readLitellmWorkersRuntime(deps.env);
  const ceilings = litellmWorkersCeilings(runtime.host);
  const stored = await deps.store.read(companyId);
  const read = await readGateway(deps, companyId);
  const current = resolveCurrent(read, await readDeclared(deps, runtime), stored, runtime.baseline);
  return buildView({ companyId, stored, ceilings, runtime, read, current });
}

/**
 * Stores the target and moves the pool to it with a planned restart.
 *
 * Order matters: the target is validated first (an impossible one is a 400 and
 * nothing is written), then stored — the operator's decision outlives a failed
 * restart — then the restart runs, and the result is read back. Only a size
 * read back is recorded as `observed`: a restart that "returned 0" but left the
 * old pool must not become the board's belief.
 */
export async function applyLitellmWorkersTarget(
  deps: LitellmWorkersDeps,
  input: { companyId: string; target: number },
): Promise<LitellmWorkersApplyResult> {
  const runtime = readLitellmWorkersRuntime(deps.env);
  const ceilings = litellmWorkersCeilings(runtime.host);
  const check = checkLitellmWorkersTarget(input.target, ceilings);
  if (!check.ok) {
    throw badRequest(check.message, {
      reason: check.reason,
      target: input.target,
      minTarget: ceilings.minTarget,
      maxByCpu: ceilings.maxByCpu,
      maxByMemory: ceilings.maxByMemory,
      maxTarget: ceilings.maxTarget,
    });
  }
  // One resize at a time per instance: the pool is read, restarted and
  // recorded inside the lock, so a second PUT counts from the first one's result.
  const lock = deps.lock ?? defaultLock;
  return lock.run(() => applyValidatedTarget(deps, input));
}

const defaultLock: LitellmWorkersLock = inProcessLitellmWorkersLock();

async function applyValidatedTarget(
  deps: LitellmWorkersDeps,
  input: { companyId: string; target: number },
): Promise<LitellmWorkersApplyResult> {
  const runtime = readLitellmWorkersRuntime(deps.env);
  const ceilings = litellmWorkersCeilings(runtime.host);

  const gatewayRead = await readGateway(deps, input.companyId);
  const before = resolveCurrent(
    gatewayRead,
    await readDeclared(deps, runtime),
    await deps.store.read(input.companyId),
    runtime.baseline,
  );

  // A pool already at the target is not restarted: the restart is the one
  // step that drops requests, and it would change nothing. Only a measured
  // size counts: the board's own record or a declared baseline may be stale.
  const measured = (source: LitellmWorkersCurrentSource): boolean => source === "gateway" || source === "launch_line";
  const alreadyThere = before.workers === input.target && measured(before.source);
  const command = runtime.restart.command;
  let refused: string | null = null;
  if (!alreadyThere) {
    if (command === null) {
      refused =
        "no restart command is configured (MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND), so the board only stored the target; restart the gateway unit with the new --num_workers in the planned window";
    } else if (before.workers === null) {
      refused =
        "the pool size could not be read (no gateway gauge, no readable --num_workers in the unit file, no recorded or declared size), so the restart cannot be confirmed; the board only stored the target";
    }
  }

  let deliveries: LitellmRestartDelivery[] = [];
  let applyError = refused;
  if (!alreadyThere && refused === null && command !== null) {
    const rendered = renderLitellmWorkersRestartCommand(command, input.target);
    const runner = deps.restartRunner ?? createShellLitellmRestartRunner();
    const result = await runner.run(rendered);
    deliveries = [{ command: rendered, ok: result.ok, error: result.error }];
    if (!result.ok) applyError = `the gateway restart failed: ${result.error ?? "unknown failure"}`;
  }
  const restarted = deliveries.length > 0;

  // The confirmation: what the gateway runs now, read back after the restart.
  // The board's own record is not a confirmation, so it is left out of the read.
  let confirmed: LitellmWorkersCurrent | null = null;
  if (restarted) {
    const now = resolveCurrent(
      await readGateway(deps, input.companyId),
      await readDeclared(deps, runtime),
      { target: null, observed: null },
      null,
    );
    confirmed = measured(now.source) ? now : null;
    if (applyError === null) {
      if (confirmed === null) {
        applyError =
          "the gateway was restarted but its new pool size could not be confirmed (no gateway gauge and no readable --num_workers); check the unit";
      } else if (confirmed.workers !== input.target) {
        applyError = `the gateway was restarted but runs ${confirmed.workers} worker process(es), not the requested ${input.target}`;
      }
    }
  }
  const currentAfter: LitellmWorkersCurrent = confirmed ?? before;
  const observedNow = confirmed ?? (alreadyThere ? before : null);

  const stored = await deps.store.mutate(input.companyId, (previous) => ({
    next: {
      target: input.target,
      observed:
        observedNow === null || observedNow.workers === null
          ? previous.observed
          : { workers: observedNow.workers, at: new Date().toISOString() },
    },
    result: previous,
  }));

  const after = await readGateway(deps, input.companyId);
  return {
    view: buildView({
      companyId: input.companyId,
      stored: stored.doc,
      ceilings,
      runtime,
      read: after,
      current: currentAfter,
    }),
    applied: applyError === null && currentAfter.workers === input.target && (restarted || alreadyThere),
    restarted,
    deliveries,
    applyError,
    changed: (stored.result.target ?? null) !== input.target,
  };
}
