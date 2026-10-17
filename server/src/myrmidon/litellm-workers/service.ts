// server/src/myrmidon/litellm-workers/service.ts
//
// myrmidon(1.6.5 LITELLM-WORKERS A): what a GET reports and what a PUT does.
//
// The whole decision lives here, over three ports (the settings store, the
// gateway read, the signal delivery), so both routes are thin and the tests
// run without a database, a container or a signal.
//
// Reading the pool size is the delicate part, because a wrong `current` makes
// a wrong number of signals: one TTIN too many is an over-provisioned box. The
// size is therefore taken from the most trustworthy source that has one, and
// the answer says which one it was:
//
//   1. the gateway's own pool gauge, when it publishes one;
//   2. the board's record of what it last observed or delivered — the only
//      source that knows about a resize the board itself made;
//   3. the declared baseline (`--num_workers N` of the unit), for a gateway
//      that publishes nothing and has never been resized;
//   4. the per-pid hint of the exposition, which a single scrape usually
//      answers about ONE worker, so it is the last resort and is labelled.
//
// With none of the four there is no `current`, and the resize is refused with
// a sentence rather than guessed: the target is stored (it is the operator's
// decision) and the answer says the pool was left alone.

import {
  checkLitellmWorkersTarget,
  litellmWorkersCeilings,
  litellmWorkersSignalSteps,
  readLitellmWorkersRuntime,
  renderLitellmWorkersSignalCommand,
  resolveLitellmWorkersTarget,
  type LitellmWorkersCeilings,
  type LitellmWorkersHostShape,
  type LitellmWorkersMetrics,
  type LitellmWorkersSignalStep,
  type LitellmWorkersStoredSettings,
} from "@paperclipai/shared";
import { badRequest } from "../../errors.js";
import {
  createShellLitellmSignalRunner,
  deliverLitellmWorkersSignals,
  type LitellmMetricsRead,
  type LitellmSignalDelivery,
  type LitellmSignalRunner,
  type LitellmWorkersGatewayPort,
} from "./gateway.js";
import { unavailableLitellmWorkersMetrics } from "./metrics.js";
import { inProcessLitellmWorkersLock, type LitellmWorkersLock, type LitellmWorkersStore } from "./settings.js";

/** Where the `current` in an answer came from. */
export type LitellmWorkersCurrentSource = "gateway" | "last_applied" | "baseline" | "gateway_pids" | "unknown";

export interface LitellmWorkersDeps {
  store: LitellmWorkersStore;
  env: Record<string, string | undefined>;
  /** The gateway read port; null when no gateway endpoint is configured. */
  gateway: LitellmWorkersGatewayPort | null;
  /** The delivery port; the shell runner unless a test passes a recording one. */
  signalRunner?: LitellmSignalRunner;
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
  apply: { path: "gunicorn-ttin-ttou"; configured: boolean; command: string; container: string };
  observedAt: string | null;
}

/** A resize: what was asked, what was delivered, and the state afterwards. */
export interface LitellmWorkersApplyResult {
  view: LitellmWorkersView;
  /** True when the pool is believed to be at the target now. */
  applied: boolean;
  /** The signals the difference asked for. */
  signals: LitellmWorkersSignalStep[];
  /** Every command actually run, in order. */
  deliveries: LitellmSignalDelivery[];
  applyError: string | null;
  /** False when the stored target did not change. */
  changed: boolean;
}

/** The size of the pool as one source or another reports it. */
interface LitellmWorkersCurrent {
  workers: number | null;
  source: LitellmWorkersCurrentSource;
}

function resolveCurrent(read: LitellmMetricsRead | null, stored: LitellmWorkersStoredSettings, baseline: number | null): LitellmWorkersCurrent {
  if (read !== null && read.ok) {
    if (read.workersSource === "gauge" && read.workers !== null) return { workers: read.workers, source: "gateway" };
    if (read.workersSource === "pids" && read.workers !== null) {
      return { workers: read.workers, source: "gateway_pids" };
    }
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
async function readGateway(deps: LitellmWorkersDeps): Promise<LitellmMetricsRead | null> {
  if (deps.gateway === null) return null;
  return deps.gateway.readMetrics();
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
    apply: {
      path: "gunicorn-ttin-ttou",
      configured: true,
      command: runtime.signal.command,
      container: runtime.signal.container,
    },
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
  const read = await readGateway(deps);
  const current = resolveCurrent(read, stored, runtime.baseline);
  return buildView({ companyId, stored, ceilings, runtime, read, current });
}

/**
 * Stores the target and moves the pool to it without a restart.
 *
 * Order matters: the target is validated first (an impossible one is a 400 and
 * nothing is written), then stored — the operator's decision outlives a failed
 * delivery — and then delivered. What the delivery actually did is recorded as
 * the new `observed`, so a retry counts from the real pool instead of from the
 * intention: half a shrink delivered twice would otherwise empty the pool.
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
  // One resize at a time per instance: the pool is read, signalled and
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

  const gatewayRead = await readGateway(deps);
  const current = resolveCurrent(gatewayRead, await deps.store.read(input.companyId), runtime.baseline);
  const runner = deps.signalRunner ?? createShellLitellmSignalRunner();
  const render = (signal: string): string =>
    renderLitellmWorkersSignalCommand(runtime.signal.command, { signal, container: runtime.signal.container });

  // The signals depend on a known pool size. Without one, nothing is delivered
  // and the answer says why — see the four sources at the top of this file.
  const signals = current.workers === null ? [] : litellmWorkersSignalSteps(current.workers, input.target);
  const refused =
    current.workers === null
      ? "the gateway did not report its worker count, so the number of TTIN/TTOU signals cannot be counted; set the declared baseline (MYRMIDON_LITELLM_WORKERS_BASELINE) or expose the pool size in the gateway metrics"
      : null;

  let deliveries: LitellmSignalDelivery[] = [];
  let applyError = refused;
  if (refused === null && signals.length > 0) {
    const delivered = await deliverLitellmWorkersSignals(runner, signals, render);
    deliveries = delivered.deliveries;
    applyError = delivered.error;
  }

  // What the pool is now: the size the signals moved it to, or what the
  // gateway itself says when the delivery succeeded and it answers.
  const deliveredCount = deliveries.filter((delivery) => delivery.ok).length;
  const grew = signals[0]?.signal === "TTIN";
  const moved = current.workers === null ? null : current.workers + (grew ? deliveredCount : -deliveredCount);
  const reread = applyError === null ? await readGateway(deps) : null;
  const rereadWorkers = reread !== null && reread.ok && reread.workers !== null ? reread.workers : null;
  const observedWorkers = rereadWorkers ?? (applyError === null ? input.target : moved);

  const stored = await deps.store.mutate(input.companyId, (before) => ({
    next: {
      target: input.target,
      observed:
        observedWorkers === null
          ? before.observed
          : { workers: observedWorkers, at: new Date().toISOString() },
    },
    result: before,
  }));

  const after = await readGateway(deps);
  const currentAfter: LitellmWorkersCurrent =
    applyError === null && rereadWorkers !== null
      ? { workers: rereadWorkers, source: "gateway" }
      : current.workers === null
        ? { workers: null, source: "unknown" }
        : { workers: moved, source: "last_applied" };

  return {
    view: buildView({
      companyId: input.companyId,
      stored: stored.doc,
      ceilings,
      runtime,
      read: after,
      current: currentAfter,
    }),
    applied: applyError === null,
    signals,
    deliveries,
    applyError,
    changed: (stored.result.target ?? null) !== input.target,
  };
}