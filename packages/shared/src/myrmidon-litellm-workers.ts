// packages/shared/src/myrmidon-litellm-workers.ts
//
// myrmidon(1.6.5 LITELLM-WORKERS A): the shared contract of the LiteLLM
// worker-process count — the stored per-company target, the arithmetic that
// turns the gateway container's shape into its two ceilings, and the
// validation the route and the card share.
//
// Everything here is pure and takes the container shape as an argument: the
// numbers of a live host never live in this file. The defaults below describe
// the production container the ticket names (6 cores / 12 GB, an upper-bound
// estimate of 1.5 GB per worker process), and every caller may pass its own.
//
// Why a default of `cores - 1`: one core is left to the gunicorn master and
// the board it serves, so a pool of `cores - 1` utilises the box without the
// master and the workers competing for the same slice. The ceiling is not the
// default: `maxByCpu` is the number of cores, because an operator may claim
// the whole box deliberately.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Keys and environment variables
// ---------------------------------------------------------------------------

/** The `instance_settings.general` key holding the per-company documents. */
export const LITELLM_WORKERS_COMPANIES_KEY = "myrmidonLitellmWorkersCompanies";

/** The container's CPU count; unset means the production 6. */
export const LITELLM_WORKERS_CORES_ENV = "MYRMIDON_LITELLM_WORKERS_CORES";

/** The container's memory limit in GB; unset means the production 12. */
export const LITELLM_WORKERS_MEMORY_GB_ENV = "MYRMIDON_LITELLM_WORKERS_MEMORY_GB";

/**
 * The command that delivers one gunicorn master signal. `{signal}` and
 * `{container}` are substituted per delivery; the default is the production
 * contour, where the gateway is the container's PID 1 and `docker kill -s`
 * therefore reaches the gunicorn master.
 */
export const LITELLM_WORKERS_SIGNAL_COMMAND_ENV = "MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND";

/** The container the signal command addresses; unset means `litellm-gateway`. */
export const LITELLM_WORKERS_CONTAINER_ENV = "MYRMIDON_LITELLM_WORKERS_CONTAINER";

/**
 * The pool size the gateway's unit starts with (`--num_workers N` on the
 * production node it is 4). Only needed while the gateway reports no pool size
 * of its own AND the board has never resized it: it is the baseline the first
 * TTIN/TTOU count is measured from. Unset means "unknown", and then the first
 * resize is refused rather than guessed.
 */
export const LITELLM_WORKERS_BASELINE_ENV = "MYRMIDON_LITELLM_WORKERS_BASELINE";

// ---------------------------------------------------------------------------
// Defaults and bounds
// ---------------------------------------------------------------------------

/** The production container the ticket names. */
export const DEFAULT_LITELLM_WORKERS_CORES = 6;
export const DEFAULT_LITELLM_WORKERS_MEMORY_GB = 12;

/** The upper-bound memory estimate for ONE worker process. */
export const DEFAULT_LITELLM_WORKERS_GB_PER_WORKER = 1.5;

/** The floor: a gunicorn master with no worker cannot serve anything. */
export const MIN_LITELLM_WORKERS = 1;

/** Cores left to the master by the default (`cores - 1`). */
export const LITELLM_WORKERS_DEFAULT_CORE_RESERVE = 1;

/** The production signal path: the master is the container's PID 1. */
export const DEFAULT_LITELLM_WORKERS_SIGNAL_COMMAND = "docker kill -s {signal} {container}";
export const DEFAULT_LITELLM_WORKERS_CONTAINER = "litellm-gateway";

/** The two gunicorn master signals that resize the pool in place. */
export const LITELLM_WORKER_GROW_SIGNAL = "TTIN";
export const LITELLM_WORKER_SHRINK_SIGNAL = "TTOU";

// ---------------------------------------------------------------------------
// The container's shape and the ceilings it implies
// ---------------------------------------------------------------------------

/** How the gateway container is built: its cores, its memory, one worker's share. */
export interface LitellmWorkersHostShape {
  cores: number;
  memoryGb: number;
  gbPerWorker: number;
}

/** Where a host number came from, so a card can say it. */
export type LitellmWorkersHostSource = "env" | "default";

/** The four numbers a company may set a target between, and the default target. */
export interface LitellmWorkersCeilings {
  minTarget: number;
  maxByCpu: number;
  maxByMemory: number;
  /** min(maxByCpu, maxByMemory): the target the routes accept as the largest. */
  maxTarget: number;
  /** What an unset target resolves to: `cores - 1`, clamped by both ceilings. */
  defaultTarget: number;
}

/** The stored document of one company, as the routes and the store agree on it. */
export interface LitellmWorkersStoredSettings {
  /** The board's target; null means the default (`cores - 1`). */
  target: number | null;
  /**
   * The pool size the board last read from the gateway or last delivered to it,
   * with when — the fallback `current` of a GET while the gateway is
   * unreachable. Null until the board has ever seen the pool.
   */
  observed: { workers: number; at: string } | null;
}

/** The three live numbers the GET reports; null where the gateway cannot answer. */
export interface LitellmWorkersMetrics {
  /** Mean CPU fraction (0..1) of one worker over the last two scrapes. */
  perWorkerCpu: number | null;
  /** The median answer time over the gateway's latency histogram. */
  medianLatencyMs: number | null;
  /** Requests accepted but not answered yet. */
  queueDepth: number | null;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How many workers the CPU count allows: one per core, never none. */
export function litellmWorkersMaxByCpu(cores: number): number {
  return Math.max(MIN_LITELLM_WORKERS, Math.floor(positiveNumber(cores, DEFAULT_LITELLM_WORKERS_CORES)));
}

/** How many workers the memory limit allows under the per-process estimate. */
export function litellmWorkersMaxByMemory(memoryGb: number, gbPerWorker: number): number {
  const per = positiveNumber(gbPerWorker, DEFAULT_LITELLM_WORKERS_GB_PER_WORKER);
  const total = positiveNumber(memoryGb, DEFAULT_LITELLM_WORKERS_MEMORY_GB);
  return Math.max(MIN_LITELLM_WORKERS, Math.floor(total / per));
}

/**
 * The ceilings and the default target of one container shape. The default is
 * `cores - 1` clamped into [minTarget, maxTarget], so a container whose memory
 * is the tighter ceiling never starts at a target the route would reject.
 */
export function litellmWorkersCeilings(shape: LitellmWorkersHostShape): LitellmWorkersCeilings {
  const maxByCpu = litellmWorkersMaxByCpu(shape.cores);
  const maxByMemory = litellmWorkersMaxByMemory(shape.memoryGb, shape.gbPerWorker);
  const maxTarget = Math.max(MIN_LITELLM_WORKERS, Math.min(maxByCpu, maxByMemory));
  const cores = Math.floor(positiveNumber(shape.cores, DEFAULT_LITELLM_WORKERS_CORES));
  const preferred = cores - LITELLM_WORKERS_DEFAULT_CORE_RESERVE;
  const defaultTarget = Math.min(Math.max(preferred, MIN_LITELLM_WORKERS), maxTarget);
  return { minTarget: MIN_LITELLM_WORKERS, maxByCpu, maxByMemory, maxTarget, defaultTarget };
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

/** Why a target was rejected; the route answers 400 for every one of them. */
export type LitellmWorkersTargetRejection = "not_integer" | "below_minimum" | "above_memory" | "above_cpu";

export interface LitellmWorkersTargetCheck {
  ok: boolean;
  reason: LitellmWorkersTargetRejection | null;
  /** The operator-facing sentence, empty when the target passes. */
  message: string;
}

/**
 * Whether a target is one the gateway can actually be given.
 *
 * The memory ceiling is checked before the CPU one so a target beyond both
 * reports the rule the ticket names (N * 1.5 GB <= the container's memory)
 * rather than whichever number happened to be smaller.
 */
export function checkLitellmWorkersTarget(
  target: unknown,
  ceilings: LitellmWorkersCeilings,
): LitellmWorkersTargetCheck {
  if (typeof target !== "number" || !Number.isInteger(target)) {
    return { ok: false, reason: "not_integer", message: "target must be an integer number of worker processes" };
  }
  if (target < ceilings.minTarget) {
    return {
      ok: false,
      reason: "below_minimum",
      message: `target must be at least ${ceilings.minTarget} worker process`,
    };
  }
  if (target > ceilings.maxByMemory) {
    return {
      ok: false,
      reason: "above_memory",
      message: `target ${target} exceeds maxByMemory ${ceilings.maxByMemory}`,
    };
  }
  if (target > ceilings.maxByCpu) {
    return { ok: false, reason: "above_cpu", message: `target ${target} exceeds maxByCpu ${ceilings.maxByCpu}` };
  }
  return { ok: true, reason: null, message: "" };
}

/**
 * The target in force: the stored one, or the container's default.
 *
 * A stored target the container can no longer hold — the box was resized down
 * after the value was written — is reported as the default rather than as a
 * target the gateway could never be given.
 */
export function resolveLitellmWorkersTarget(
  stored: LitellmWorkersStoredSettings,
  ceilings: LitellmWorkersCeilings,
): { target: number; source: "settings" | "default" } {
  if (stored.target !== null && checkLitellmWorkersTarget(stored.target, ceilings).ok) {
    return { target: stored.target, source: "settings" };
  }
  return { target: ceilings.defaultTarget, source: "default" };
}

// ---------------------------------------------------------------------------
// Delivery: the signals that resize the pool in place
// ---------------------------------------------------------------------------

/** One signal and how many times the master must receive it. */
export interface LitellmWorkersSignalStep {
  signal: string;
  count: number;
}

/**
 * The steps that take a pool of `current` workers to `target` without a
 * restart: gunicorn's master grows by one worker per TTIN and drops one per
 * TTOU, so the difference is delivered as that many signals. An equal pair
 * asks for nothing.
 */
export function litellmWorkersSignalSteps(current: number, target: number): LitellmWorkersSignalStep[] {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return [];
  const delta = Math.trunc(target) - Math.trunc(current);
  if (delta === 0) return [];
  return delta > 0
    ? [{ signal: LITELLM_WORKER_GROW_SIGNAL, count: delta }]
    : [{ signal: LITELLM_WORKER_SHRINK_SIGNAL, count: Math.abs(delta) }];
}

/** The signal command with its placeholders filled in. */
export function renderLitellmWorkersSignalCommand(
  template: string,
  input: { signal: string; container: string },
): string {
  return template.split("{signal}").join(input.signal).split("{container}").join(input.container);
}

// ---------------------------------------------------------------------------
// The runtime shape, read from an environment
// ---------------------------------------------------------------------------

/** The container shape and the delivery path, as the instance declares them. */
export interface LitellmWorkersRuntime {
  host: LitellmWorkersHostShape;
  hostSource: { cores: LitellmWorkersHostSource; memoryGb: LitellmWorkersHostSource };
  signal: { command: string; container: string; source: LitellmWorkersHostSource };
  /** The pool the unit starts with, when the instance declares it. */
  baseline: number | null;
}

function positiveEnvNumber(raw: string | undefined, fallback: number): { value: number; source: LitellmWorkersHostSource } {
  const trimmed = raw?.trim();
  if (trimmed) {
    const value = Number(trimmed);
    if (Number.isFinite(value) && value > 0) return { value, source: "env" };
  }
  return { value: fallback, source: "default" };
}

/** A whole number of workers from an environment variable, or null. */
export function readLitellmWorkersBaseline(env: Record<string, string | undefined>): number | null {
  const trimmed = env[LITELLM_WORKERS_BASELINE_ENV]?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < MIN_LITELLM_WORKERS) return null;
  return value;
}

/**
 * Reads the container's shape and the signal path from an environment. The
 * environment is a parameter, never `process.env` read here, because this
 * module is imported by the interface too. Nothing throws: an unreadable
 * number falls back to the production value it names.
 */
export function readLitellmWorkersRuntime(env: Record<string, string | undefined>): LitellmWorkersRuntime {
  const cores = positiveEnvNumber(env[LITELLM_WORKERS_CORES_ENV], DEFAULT_LITELLM_WORKERS_CORES);
  const memoryGb = positiveEnvNumber(env[LITELLM_WORKERS_MEMORY_GB_ENV], DEFAULT_LITELLM_WORKERS_MEMORY_GB);
  const command = env[LITELLM_WORKERS_SIGNAL_COMMAND_ENV]?.trim();
  const container = env[LITELLM_WORKERS_CONTAINER_ENV]?.trim();
  const commandSource: LitellmWorkersHostSource = command ? "env" : "default";
  return {
    host: { cores: cores.value, memoryGb: memoryGb.value, gbPerWorker: DEFAULT_LITELLM_WORKERS_GB_PER_WORKER },
    hostSource: { cores: cores.source, memoryGb: memoryGb.source },
    signal: {
      command: command || DEFAULT_LITELLM_WORKERS_SIGNAL_COMMAND,
      container: container || DEFAULT_LITELLM_WORKERS_CONTAINER,
      source: commandSource,
    },
    baseline: readLitellmWorkersBaseline(env),
  };
}

// ---------------------------------------------------------------------------
// The stored document
// ---------------------------------------------------------------------------

/**
 * The stored document as the store, the sweep and the routes agree on it. A
 * hand-edited `general` can carry anything, so every field is type-checked and
 * anything unreadable reads as "not set" rather than as a number the gateway
 * would be told to obey.
 */
export function normalizeLitellmWorkersSettings(stored: unknown): LitellmWorkersStoredSettings {
  const record = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const target = record.target;
  const observed = record.observed;
  const observedRecord =
    typeof observed === "object" && observed !== null ? (observed as Record<string, unknown>) : null;
  const workers = observedRecord?.workers;
  const at = observedRecord?.at;
  return {
    target:
      typeof target === "number" && Number.isInteger(target) && target >= MIN_LITELLM_WORKERS ? target : null,
    observed:
      typeof workers === "number" && Number.isInteger(workers) && workers >= MIN_LITELLM_WORKERS && typeof at === "string"
        ? { workers, at }
        : null,
  };
}

/** The PUT body: the target, and nothing else. */
export const litellmWorkersTargetSchema = z.object({
  target: z.number().int(),
});

export type LitellmWorkersTargetBody = z.infer<typeof litellmWorkersTargetSchema>;