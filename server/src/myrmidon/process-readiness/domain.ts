// server/src/myrmidon/process-readiness/domain.ts
//
// myrmidon(1.6.6 PROCS-1.5, design BOARD-PROCESSES §4.4): the pure readiness
// rules of ONE board process and the aggregate the balancer polls. Constants
// and functions only — no DB, no timers, no Express — so the service, the
// routes and the tests share one definition of «готов принимать».
//
// The three checks are deliberately cheap: a single `SELECT 1`, the in-memory
// boot phase, and the subscription flag the bus wiring reports. A readiness
// endpoint is polled by the balancer on every deploy, so it must never run a
// heavy probe (design §4.4: «простые проверки без тяжёлых проб»).

import type { BoardProcessRole } from "../process-registry/domain.js";

/** The checks a process runs before it accepts requests. */
export const READINESS_CHECK_IDS = ["database", "migrations", "bus"] as const;
export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];

/** `not_applicable` never blocks: a role that does not use a check must not be
 * reported unhealthy because of it. */
export type ReadinessCheckStatus = "ok" | "not_ready" | "not_applicable";

export type ReadinessCheck = {
  id: ReadinessCheckId;
  status: ReadinessCheckStatus;
  /** Short operator-facing reason. Never a secret and never a raw error object. */
  detail: string | null;
};

/** The two answers the balancer understands: ready and serving, or not yet. */
export const READY_STATUS = 200;
export const NOT_READY_STATUS = 503;
export type ReadinessHttpStatus = typeof READY_STATUS | typeof NOT_READY_STATUS;

export type ProcessReadinessSnapshot = {
  ready: boolean;
  role: BoardProcessRole;
  /** Identity of the answering process, same value the registry row carries. */
  bootId: string;
  checks: ReadinessCheck[];
  at: string;
};

/** A process is ready when no check says `not_ready` (design §4.4). */
export function processReady(checks: readonly ReadinessCheck[]): boolean {
  return checks.every((check) => check.status !== "not_ready");
}

/** Supervisor states the aggregate distinguishes. Declared structurally here so
 * this module stays independent of the supervisor's own files (PROCS-1.2):
 * the supervisor already answers exactly these five names. */
export const SUPERVISOR_HEALTH_STATES = [
  "single",
  "startingSplit",
  "split",
  "drainingToSingle",
  "emergencySingle",
] as const;
export type SupervisorHealthState = (typeof SUPERVISOR_HEALTH_STATES)[number];

/** One child as the aggregate sees it: `ready` is the child's own readiness
 * flag, `draining` marks a child on its way out after a scale-down. */
export type SupervisorChildView = {
  ready: boolean;
  draining: boolean;
};

/** What the aggregate needs from the supervisor. PROCS-1.2's
 * `ProcessSupervisor` is assignable as-is: it exposes `state()` and
 * `children()` with these two fields. `desiredApiCount()` is optional, because
 * that supervisor keeps its desired settings private — when it is absent the
 * aggregate counts the live children instead, which is the same number as soon
 * as the supervisor reports `split` (it reaches that state only after every
 * child is ready). An api child has no supervisor at all and reports `null`. */
export type ProcessSupervisorReadinessSource = {
  state(): SupervisorHealthState;
  desiredApiCount?(): number;
  children(): readonly SupervisorChildView[];
};

export const HEALTHZ_REASONS = [
  "process_ready",
  "process_not_ready",
  "split_starting",
  "api_not_ready",
  "all_api_ready",
] as const;
export type HealthzReason = (typeof HEALTHZ_REASONS)[number];

export type HealthzApiCounts = {
  /** How many api processes the supervisor wants. Always >= 1. */
  desired: number;
  /** Children that are ready and not draining. */
  ready: number;
  /** Children alive but not ready yet. */
  starting: number;
};

export type HealthzInput = {
  role: BoardProcessRole;
  bootId: string;
  /** This process's own verdict: its checks, not the supervisor's.
   * `selfChecks` is reported as-is so one body answers both questions. */
  selfReady: boolean;
  selfChecks: readonly ReadinessCheck[];
  /** `null` on an api child, and on today's single process until the split
   * wiring passes the supervisor in. */
  supervisor: ProcessSupervisorReadinessSource | null;
  now?: Date;
};

export type HealthzBody = {
  status: "ok" | "not_ready";
  /** `supervisor` when the answer aggregates N api processes, `process` when it
   * describes this process alone. */
  scope: "process" | "supervisor";
  role: BoardProcessRole;
  bootId: string;
  ready: boolean;
  reason: HealthzReason;
  supervisorState: SupervisorHealthState | null;
  api: HealthzApiCounts;
  checks: ReadinessCheck[];
  at: string;
};

export type HealthzVerdict = {
  status: ReadinessHttpStatus;
  healthy: boolean;
  reason: HealthzReason;
  body: HealthzBody;
};

/** Counts the children of the supervisor: ready (and staying) against starting
 * (alive, not ready yet). Draining children are on their way out, so they are
 * neither. */
export function supervisorApiCounts(
  supervisor: ProcessSupervisorReadinessSource | null,
): HealthzApiCounts {
  if (!supervisor) return { desired: 1, ready: 0, starting: 0 };
  const children = [...supervisor.children()];
  const desired = Math.max(
    1,
    Math.trunc(supervisor.desiredApiCount?.() ?? children.length) || 1,
  );
  let ready = 0;
  let starting = 0;
  for (const child of children) {
    if (child.draining) continue;
    if (child.ready) ready += 1;
    else starting += 1;
  }
  return { desired, ready, starting };
}

/** The aggregate verdict of `/healthz` (design §4.4).
 *
 * - No supervisor (an api child): this process's own readiness is the answer.
 * - `split` / `startingSplit`: 200 only when every one of the N api processes
 *   is ready AND this process itself is ready — the supervisor is the one that
 *   applies migrations, so its own checks gate the switch to split.
 * - `single` / `emergencySingle` / `drainingToSingle`: this process serves the
 *   board itself, so its own readiness is the whole answer.
 *
 * The decision is a pure function of the state, so every lane is unit-tested
 * without spawning anything. */
export function healthzVerdict(input: HealthzInput): HealthzVerdict {
  const at = (input.now ?? new Date()).toISOString();
  const supervisor = input.supervisor;
  const state = supervisor ? supervisor.state() : null;
  const api = supervisorApiCounts(supervisor);

  let healthy: boolean;
  let reason: HealthzReason;
  if (!supervisor) {
    healthy = input.selfReady;
    reason = healthy ? "process_ready" : "process_not_ready";
  } else if (state === "startingSplit" || state === "split") {
    const allApiReady = api.ready >= api.desired;
    healthy = input.selfReady && allApiReady;
    if (healthy) reason = "all_api_ready";
    else if (!input.selfReady) reason = "process_not_ready";
    else reason = state === "startingSplit" ? "split_starting" : "api_not_ready";
  } else {
    healthy = input.selfReady;
    reason = healthy ? "process_ready" : "process_not_ready";
  }

  return {
    status: healthy ? READY_STATUS : NOT_READY_STATUS,
    healthy,
    reason,
    body: {
      status: healthy ? "ok" : "not_ready",
      scope: supervisor ? "supervisor" : "process",
      role: input.role,
      bootId: input.bootId,
      ready: healthy,
      reason,
      supervisorState: state,
      api: supervisor ? api : { desired: 1, ready: input.selfReady ? 1 : 0, starting: 0 },
      checks: input.selfChecks.map((check) => ({ ...check })),
      at,
    },
  };
}

/** The body of the per-process `/internal/ready`. Kept next to the snapshot so
 * both endpoints report the same fields under the same names. */
export function readinessBody(snapshot: ProcessReadinessSnapshot): {
  status: "ok" | "not_ready";
  ready: boolean;
  role: BoardProcessRole;
  bootId: string;
  checks: ReadinessCheck[];
  at: string;
} {
  return {
    status: snapshot.ready ? "ok" : "not_ready",
    ready: snapshot.ready,
    role: snapshot.role,
    bootId: snapshot.bootId,
    checks: snapshot.checks,
    at: snapshot.at,
  };
}