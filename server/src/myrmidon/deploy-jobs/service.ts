// Board self-deploy (myrmidon R5-A): the job lifecycle.
//
// One job walks: verify the digest as a CI image → open an instance
// maintenance window → wait for `on` → hand the job to the host executor →
// read its result (health of the new image) → leave maintenance. The board
// never runs docker itself: the switch is the deploy script's `--from-job`
// mode on the host (see scripts/myrmidon/deploy), polled through a small
// host-report file the script writes. A job whose window cannot open, whose
// step exceeds MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC, or whose health fails is
// terminal with the reason on the job; the operator's tools are the exit and
// the rollback, exactly as with a script deploy.
//
// R5-C (auto-rollback by health): with MYRMIDON_DEPLOY_AUTO_ROLLBACK on (the
// default) a failed health check is NOT terminal. The job moves to
// `rolling_back`, the host executor switches the board back to the locally
// remembered previous image (the same rollback.sh, emergency path, CI check
// as a warning only), and the job ends:
//   - `auto_rolled_back` when the previous image is healthy again — the
//     window leaves, the board serves traffic, no human took part;
//   - `failed_rollback` when the rollback itself fails — the window STAYS ON
//     for the operator, the same contract as a failed health check before.
// With MYRMIDON_DEPLOY_AUTO_ROLLBACK=0 a failed health check ends
// `failed_health` with the window on, exactly as before: the rollback stays
// the operator's tool.
//
// Invariants the service keeps:
//
// - at most one non-terminal job exists (assertNoActiveJob under the row lock);
// - the image check runs BEFORE the maintenance window opens: a refused image
//   changes nothing, not even the board's own run admission;
// - the maintenance window is entered with reason "deploy <digest-prefix>"
//   and left when the job ends, whichever way it ends;
// - maintenance_on → running only after the window reported state `on`;
// - running → succeeded only when the host reported the new version/commit
//   healthy; otherwise failed_health (no auto-rollback) or rolling_back
//   (auto-rollback); with the auto-rollback on the executor reports the
//   rollback phases directly (rolling-back/rolled-back/rollback-failed), and
//   running follows them too — a tick that missed health-failed must not
//   hang the job until the step timeout;
// - rolling_back → auto_rolled_back only when the host reported the rollback
//   done; a rollback failure is failed_rollback with the window left on.

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import {
  DEPLOY_IMAGE_REPOSITORY,
  DeployJobConflict,
  appendStep,
  assertNoActiveJob,
  digestProblem,
  isAbortable,
  isDeployJobActive,
  newDeployJob,
  parseDigest,
  retireJob,
  verifyCiImage,
  type DeployJob,
  type DeployJobDocument,
  type DeployJobStatus,
} from "./domain.js";
import { readDeployJobsSettings, type DeployJobsSettings } from "./settings.js";
// myrmidon(1.7-AUTO-UPDATE-B): the update policy the scheduler executes — the
// maintenance window, the mode (manual / auto by an approved release) and the
// fleet canary. readAutoUpdateDocument reads the interface's value; the env
// override is folded in by resolveAutoUpdateSettings, which also reports the
// source of each value.
import {
  canaryPlan,
  canaryVerdict,
  resolveAutoUpdateSettings,
  windowState,
  type AutoUpdateResolution,
  type AutoUpdateSettings,
  defaultAutoUpdateSettings,
  type CanaryPhase,
} from "./auto-update.js";
import { readAutoUpdateDocument } from "./auto-update-store.js";

/** Storage the service talks to: the instance_settings row (or a test double). */
export interface DeployJobStore {
  read(): Promise<DeployJobDocument>;
  mutate<T>(change: (current: DeployJobDocument) => { next: DeployJobDocument | null; result: T }): Promise<{
    doc: DeployJobDocument;
    result: T;
    changed: boolean;
  }>;
}

function defaultStore(db: Db): DeployJobStore {
  return {
    read: () => readDeployJobDocument(db),
    mutate: (change) => mutateDeployJobDocument(db, change),
  };
}

function fakeStore(db: unknown): DeployJobStore | null {
  const candidate = db as Partial<DeployJobStore> | null;
  if (candidate && typeof candidate.read === "function" && typeof candidate.mutate === "function") {
    return candidate as DeployJobStore;
  }
  return null;
}

function resolveStore(db: Db): DeployJobStore {
  return fakeStore(db) ?? defaultStore(db);
}

/**
 * The update policy of the settings row (1.7-AUTO-UPDATE-B). It is read through
 * the row itself, like the deploy jobs' own key. A document store standing in
 * for the row (tests) carries no policy, which is the same as a row that has
 * never been written: the defaults apply, and the caller sees that as the
 * source of the value.
 */
function readPolicy(dbArg: Db): Promise<AutoUpdateSettings> {
  const fake = (dbArg as unknown as { readAutoUpdate?: () => Promise<AutoUpdateSettings> } | null)?.readAutoUpdate;
  if (typeof fake === "function") return fake();
  if (fakeStore(dbArg)) return Promise.resolve(defaultAutoUpdateSettings());
  return readAutoUpdateDocument(dbArg);
}
import { mutateDeployJobDocument, readDeployJobDocument } from "./store.js";
import { verifyImage, type ProbeDeps } from "./registry.js";

/** What the service needs from maintenance mode (R3): the same API the deploy script uses. */
export interface DeployMaintenancePort {
  enter(input: { reason: string; drainTimeoutSec?: number }): Promise<{ id: string; state: string }>;
  exit(reason?: string): Promise<{ state: string }>;
  status(): Promise<{ instance: { id: string; state: string } | null }>;
}

/** What the host executor reports (written by deploy-from-job.sh). */
export interface HostReport {
  jobId: string;
  phase:
    | "claimed"
    | "switching"
    | "switched"
    | "health-ok"
    | "health-failed"
    | "rolling-back"
    | "rolled-back"
    | "rollback-failed"
    | "error";
  version?: string | null;
  commit?: string | null;
  detail?: string | null;
  at?: string;
}

/**
 * The fleet half of a board update (1.7-AUTO-UPDATE-B, B-2): the bots of this
 * instance, the canary batch that switches first and the rest that may only
 * follow a healthy batch. The deploy scheduler owns the decision (canaryPlan /
 * canaryVerdict) and the host-side rollout is behind this port, the same way
 * the window and the health check are. No port = the instance does not roll a
 * fleet out from the board, and the phase records exactly that instead of
 * pretending.
 */
export interface FleetCanaryPort {
  /** The bots to switch, in the order they should switch. */
  targets(): Promise<string[]>;
  /** Start the canary batch of `digest`; the rest must not start yet. */
  startCanary(input: { jobId: string; digest: string; canary: string[]; reason: string }): Promise<void>;
  /** Where the canary batch stands: running, healthy or failed. */
  verdict(input: { jobId: string; digest: string; canary: string[] }): Promise<{ phase: CanaryPhase; detail?: string | null }>;
  /** Let the rest of the fleet follow a healthy canary batch. */
  startRest(input: { jobId: string; digest: string; rest: string[] }): Promise<void>;
}

export interface DeployJobServiceDeps {
  maintenance: DeployMaintenancePort;
  /** Read the host executor's report file (or fetch it); null when there is none yet. */
  readHostReport: (jobId: string) => Promise<HostReport | null>;
  /** Health facts of the running server, as /api/health reports them. */
  readHealth: () => Promise<{ version: string | null; commit: string | null } | null>;
  now?: () => Date;
  settings?: DeployJobsSettings;
  probes?: ProbeDeps;
  logActivity?: typeof logActivity;
  /**
   * 1.7-AUTO-UPDATE-B: read the update policy from the interface. Called on
   * every use, never cached: a setting changed in the interface must take
   * effect without a restart (the ticket's own rule).
   */
  readAutoUpdate?: () => Promise<AutoUpdateSettings>;
  /** Test seam for the resolved policy (stored value + env override + sources). */
  autoUpdatePolicy?: () => Promise<AutoUpdateResolution>;
  /** The fleet canary port; absent when the instance has no fleet rollout. */
  fleetCanary?: FleetCanaryPort;
}

export class DeployJobError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface DeployJobView extends DeployJob {
  active: boolean;
  abortable: boolean;
}

export function toView(job: DeployJob): DeployJobView {
  return { ...job, active: isDeployJobActive(job.status), abortable: isAbortable(job) };
}

export function deployJobsService(db: Db, deps: DeployJobServiceDeps) {
  const store = resolveStore(db);
  const now = deps.now ?? (() => new Date());
  const settings = deps.settings ?? readDeployJobsSettings();
  const audit = deps.logActivity ?? ((dbArg, entry) => logActivity(dbArg, entry));
  // The policy is read per use (see DeployJobServiceDeps.readAutoUpdate): the
  // interface is the source of truth and env is only a forced override.
  const readStoredAutoUpdate = deps.readAutoUpdate ?? (() => readPolicy(db));
  const resolvePolicy = deps.autoUpdatePolicy ?? (async () => resolveAutoUpdateSettings(await readStoredAutoUpdate()));

  /**
   * B-1 (1.7-AUTO-UPDATE-B): a verified job whose maintenance window is shut
   * waits in `waiting_window` instead of opening the window. Nothing else may
   * start in the meantime (the job stays active), and the tick above resumes
   * the deploy as soon as the window opens.
   */
  async function awaitWindowOrEnter(job: DeployJob) {
    const at = now();
    const policy = await resolvePolicy();
    const state = windowState(policy.settings.window, at);
    if (state.open) {
      await enterMaintenance(job);
      return;
    }
    await write((doc) => {
      const current = doc.jobs.find((j) => j.id === job.id);
      if (!current || current.status !== "verified") return { next: null, result: null };
      const next = appendStep(
        { ...current, status: "waiting_window", windowOpensAt: state.opensAt, updatedAt: at.toISOString() },
        "waiting_window",
        `the deploy waits for the maintenance window: ${state.reason}`,
        at,
      );
      return { next: { ...doc, jobs: doc.jobs.map((j) => (j.id === job.id ? next : j)) }, result: next.status };
    });
  }

  /**
   * B-2 (1.7-AUTO-UPDATE-B): the board switched and is healthy. The fleet does
   * not switch at once: the canary batch goes first and the rest only follows a
   * healthy batch (canaryPlan/canaryVerdict). Without a fleet port the phase is
   * recorded as such — the instance simply has no fleet to roll out.
   */
  async function handToFleetCanary(jobId: string, detail: string, report: HostReport) {
    const at = now();
    const policy = await resolvePolicy();
    const port = deps.fleetCanary;
    let plan = canaryPlan([], policy.settings.canary);
    if (port) {
      const targets = await port.targets().catch((err) => {
        logger.error({ err, jobId }, "failed to read the fleet of the canary batch");
        return [] as string[];
      });
      plan = canaryPlan(targets, policy.settings.canary);
    }
    const startable = port !== undefined && plan.enabled && plan.canary.length > 0;
    const { result } = await write((doc) => {
      const current = doc.jobs.find((j) => j.id === jobId);
      if (!current || current.status !== "running") return { next: null, result: null as DeployJob | null };
      const next = appendStep(
        {
          ...current,
          status: startable ? "fleet_canary" : "succeeded",
          healthVersion: report.version ?? null,
          healthCommit: report.commit ?? null,
          canaryBatch: startable ? plan.canary : [],
          fleetRest: startable ? plan.rest : [],
          canaryStartedAt: startable ? at.toISOString() : null,
          failureReason: null,
          updatedAt: at.toISOString(),
        },
        startable ? "fleet_canary" : "succeeded",
        startable
          ? `${detail}; the fleet follows the canary batch first: ${plan.reason}`
          : `${detail}; fleet: ${port ? plan.reason : "no fleet canary on this instance, the fleet is not rolled out from the board"}`,
        at,
      );
      const jobs = doc.jobs.map((j) => (j.id === jobId ? next : j));
      return startable
        ? { next: { ...doc, jobs }, result: next as DeployJob | null }
        : { next: retireJob({ ...doc, jobs }, jobId, at), result: next as DeployJob | null };
    });
    if (!result) return;
    if (!startable) {
      await deps.maintenance.exit("deploy finished").catch((err) => {
        logger.error({ err, jobId }, "failed to leave maintenance after deploy");
      });
      return;
    }
    try {
      await port!.startCanary({
        jobId,
        digest: result.digest,
        canary: plan.canary,
        reason: `board deploy ${result.digest.slice(0, 19)} is healthy: the canary batch switches before the rest`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await completeCanary(jobId, "canary_failed", `the canary batch could not be started: ${message}`);
    }
  }

  /**
   * B-2: retire the job at the end of the canary phase. `canary_failed` is a
   * terminal failure like `failed_health`: the rest of the fleet stays on the
   * previous image and the operator reads the reason in the interface.
   */
  async function completeCanary(jobId: string, status: Extract<DeployJobStatus, "succeeded" | "canary_failed">, detail: string) {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "fleet_canary") return { next: null, result: null as DeployJob | null };
      const next = appendStep(
        { ...job, status, failureReason: status === "canary_failed" ? detail : null, updatedAt: at.toISOString() },
        status,
        detail,
        at,
      );
      return { next: retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at), result: next as DeployJob | null };
    });
    if (!result) return;
    await deps.maintenance.exit(status === "succeeded" ? "deploy finished" : "deploy canary failed").catch((err) => {
      logger.error({ err, jobId }, "failed to leave maintenance after the fleet canary");
    });
  }

  async function findActiveJob(): Promise<DeployJob | null> {
    const doc = await store.read();
    return doc.jobs.find((j) => isDeployJobActive(j.status)) ?? null;
  }

  async function write<T>(change: (doc: DeployJobDocument) => { next: DeployJobDocument | null; result: T }) {
    return store.mutate(change);
  }

  function updateJob(doc: DeployJobDocument, id: string, patch: Partial<DeployJob>): DeployJobDocument {
    return { ...doc, jobs: doc.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) };
  }

  async function auditFor(job: DeployJob, action: string, actor: { actorType: string; actorId: string }, details: Record<string, unknown> = {}) {
    try {
      await audit(db, {
        companyId: job.companyId,
        actorType: actor.actorType as "user" | "system",
        actorId: actor.actorId,
        action: `myrmidon.deploy_jobs.${action}`,
        entityType: "myrmidon_deploy_job",
        entityId: job.id,
        details: { digest: job.digest, status: job.status, ...details },
      });
    } catch (err) {
      logger.error({ err, jobId: job.id, action }, "failed to write deploy job activity");
    }
  }

  async function currentView(): Promise<{ job: DeployJobView | null; history: DeployJobView[] }> {
    const doc = await store.read();
    const active = doc.jobs.find((j) => isDeployJobActive(j.status)) ?? null;
    const last = doc.jobs[doc.jobs.length - 1] ?? doc.history[0] ?? null;
    return {
      job: active ? toView(active) : last ? toView(last) : null,
      history: doc.history.map(toView),
    };
  }

  /** Preview: verify a digest without creating a job. Read-only. */
  async function preview(reference: string) {
    const problem = digestProblem(reference ?? "");
    if (problem) throw new DeployJobError(400, problem);
    const verification = await verifyImage(reference, deps.probes);
    return verification;
  }

  /** Create a job and start verification. */
  async function create(input: { reference: string; reason?: string }, actor: { actorType: string; actorId: string }): Promise<DeployJobView> {
    if (!settings.enabled) {
      throw new DeployJobError(503, "deploys from the interface are not enabled on this instance (MYRMIDON_DEPLOY_ENABLED)");
    }
    const problem = digestProblem(input.reference ?? "");
    if (problem) throw new DeployJobError(400, problem);
    const digest = parseDigest(input.reference)!;

    const { result: created } = await write((doc) => {
      try {
        assertNoActiveJob(doc);
      } catch (err) {
        if (err instanceof DeployJobConflict) throw new DeployJobError(409, err.message);
        throw err;
      }
      const job = newDeployJob({
        id: randomUUID(),
        companyId: "", // filled below from the first company; instance-level feature
        digest,
        reason: (input.reason ?? `deploy ${DEPLOY_IMAGE_REPOSITORY}@${digest.slice(0, 19)}`).slice(0, 500),
        startedBy: actor,
        now: now(),
      });
      return { next: { ...doc, jobs: [...doc.jobs, job] }, result: job };
    });

    await auditFor(created, "created", actor);
    // Verification runs outside the lock; its result lands on the job (and a
    // refusal retires the job into history — the operator reads the reason
    // from the returned view and from history).
    const verification = await verifyImage(`${DEPLOY_IMAGE_REPOSITORY}@${digest}`, deps.probes);
    const applied = await applyVerification(created.id, verification);
    let job: DeployJob = applied;
    if (job.status === "verified") {
      await awaitWindowOrEnter(job);
    } else {
      await auditFor(job, "image_refused", actor, { reason: job.failureReason });
    }
    const after = (await store.read()).jobs.find((j) => j.id === created.id) ?? job;
    return toView(after);
  }

  async function applyVerification(jobId: string, verification: Awaited<ReturnType<typeof verifyImage>>): Promise<DeployJob> {
    const at = now();
    let applied: DeployJob | null = null;
    await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || (job.status !== "verifying" && job.status !== "pending")) return { next: null, result: null };
      if (verification.ok) {
        const next = appendStep(
          { ...job, status: "verified", version: verification.version, commit: verification.commit, verifiedAt: at.toISOString(), updatedAt: at.toISOString(), failureReason: null },
          "verified",
          `verified CI image: commit ${verification.commit?.slice(0, 12)}, version ${verification.version ?? "<none>"}`,
          at,
        );
        applied = next;
        return { next: updateJob(doc, jobId, next), result: next.status };
      }
      const next = appendStep(
        { ...job, status: "failed_verification", failureReason: verification.reason, updatedAt: at.toISOString() },
        "failed_verification",
        verification.reason ?? "image refused",
        at,
      );
      applied = next;
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: "failed_verification" };
    });
    if (applied) return applied;
    // Another writer already moved the job (a restart, a concurrent tick):
    // return whatever is stored now.
    const stored = (await store.read()).jobs.find((j) => j.id === jobId);
    if (stored) return stored;
    throw new DeployJobError(404, "deploy job not found");
  }

  async function enterMaintenance(job: DeployJob) {
    const at = now();
    try {
      const window = await deps.maintenance.enter({ reason: `deploy ${DEPLOY_IMAGE_REPOSITORY}@${job.digest.slice(0, 19)}` });
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || !isDeployJobActive(current.status) || current.status === "running") return { next: null, result: null };
        const next = appendStep(
          { ...current, status: "maintenance_entering", maintenanceWindowId: window.id, updatedAt: at.toISOString() },
          "maintenance_entering",
          `maintenance window ${window.id} entered (state ${window.state})`,
          at,
        );
        return { next: updateJob(doc, job.id, next), result: next.status };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || !isDeployJobActive(current.status)) return { next: null, result: null };
        const next = appendStep(
          { ...current, status: "maintenance_failed", failureReason: `maintenance enter failed: ${message}`, updatedAt: at.toISOString() },
          "maintenance_failed",
          `maintenance enter failed: ${message}`,
          at,
        );
        const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === job.id ? next : j)) }, job.id, at);
        return { next: retired, result: "maintenance_failed" };
      });
      await auditFor(job, "maintenance_failed", { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { error: message });
    }
  }

  /** Abort a job that has not started the image switch. */
  async function abort(jobId: string, actor: { actorType: string; actorId: string }): Promise<DeployJobView> {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job) return { next: null, result: new DeployJobError(404, "deploy job not found") as DeployJobError | DeployJob };
      if (!isAbortable(job)) {
        return {
          next: null,
          result: new DeployJobError(409, `job in status ${job.status} cannot be aborted: the image switch already started; use the rollback`) as DeployJobError | DeployJob,
        };
      }
      const next = appendStep(
        { ...job, status: "aborted", failureReason: "aborted by operator", updatedAt: at.toISOString() },
        "aborted",
        "aborted by operator",
        at,
      );
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next as DeployJob };
    });
    if (result instanceof DeployJobError) throw result;
    // Leave the window the job opened (a no-op when none was opened yet).
    await deps.maintenance.exit("deploy job aborted").catch((err) => {
      logger.error({ err, jobId }, "failed to leave maintenance after abort");
    });
    await auditFor(result, "aborted", actor);
    return toView(result);
  }

  /**
   * The reconciliation tick: drive the open job forward from facts (window
   * state, host report, health), the way the maintenance tick drives windows.
   * Safe to run often; every step is idempotent and guarded by status checks.
   */
  async function tick(): Promise<void> {
    const doc = await store.read();
    const job = doc.jobs.find((j) => isDeployJobActive(j.status));
    if (!job) return;
    const at = now();

    // A step stuck too long aborts the job: the interface must not leave a
    // half-open window forever (MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC per status).
    // Two phases are exempt from that budget and carry their own instead:
    // `waiting_window` (the window may be a week away — B-1) and
    // `fleet_canary` (the batch is watched for its own settle time — B-2).
    const lastStep = job.steps[job.steps.length - 1];
    const waited = at.getTime() - Date.parse(job.updatedAt);
    if (job.status === "waiting_window" && waited > settings.windowWaitTimeoutMs) {
      await failJob(job.id, "aborted", `the maintenance window did not open within ${Math.round(settings.windowWaitTimeoutMs / 1000)}s (window opens ${job.windowOpensAt ?? "never"})`);
      return;
    }
    if (job.status === "fleet_canary" && waited > settings.canaryTimeoutMs) {
      await completeCanary(job.id, "canary_failed", `the fleet canary did not report a verdict within ${Math.round(settings.canaryTimeoutMs / 1000)}s`);
      return;
    }
    if (lastStep && job.status !== "waiting_window" && job.status !== "fleet_canary" && waited > settings.stepTimeoutMs) {
      await failJob(job.id, "aborted", `step ${job.status} exceeded the timeout (${Math.round(settings.stepTimeoutMs / 1000)}s)`);
      return;
    }

    switch (job.status) {
      case "waiting_window": {
        // B-1: hold the deploy until the window opens. The interface shows when
        // it opens; a changed setting takes effect on the next tick.
        const policy = await resolvePolicy();
        const state = windowState(policy.settings.window, at);
        if (!state.open) {
          if (state.opensAt !== job.windowOpensAt) {
            await write((doc2) => {
              const current = doc2.jobs.find((j) => j.id === job.id);
              if (!current || current.status !== "waiting_window") return { next: null, result: null };
              const next = appendStep(
                { ...current, windowOpensAt: state.opensAt, updatedAt: at.toISOString() },
                "waiting_window",
                `still outside the maintenance window: ${state.reason}`,
                at,
              );
              return { next: { ...doc2, jobs: doc2.jobs.map((j) => (j.id === job.id ? next : j)) }, result: next.status };
            });
          }
          return;
        }
        const ready = (await store.read()).jobs.find((j) => j.id === job.id);
        if (ready && ready.status === "waiting_window") {
          await write((doc2) => {
            const current = doc2.jobs.find((j) => j.id === job.id);
            if (!current || current.status !== "waiting_window") return { next: null, result: null };
            const next = appendStep(
              { ...current, windowOpensAt: null, updatedAt: at.toISOString() },
              "waiting_window",
              `the maintenance window is open: ${state.reason}`,
              at,
            );
            return { next: { ...doc2, jobs: doc2.jobs.map((j) => (j.id === job.id ? next : j)) }, result: next.status };
          });
          const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
          if (fresh && fresh.status === "waiting_window") await enterMaintenance(fresh);
        }
        return;
      }
      case "fleet_canary": {
        // B-2: the board switched; the canary batch is watched for at least the
        // configured settle time, and only a healthy batch lets the rest follow.
        if (!deps.fleetCanary) {
          await completeCanary(job.id, "succeeded", "no fleet canary on this instance: nothing to wait for");
          return;
        }
        const policy = await resolvePolicy();
        const startedAt = job.canaryStartedAt === null ? at.getTime() : Date.parse(job.canaryStartedAt);
        if (at.getTime() - startedAt < policy.settings.canary.healthSettleSec * 1000) return;
        const port = deps.fleetCanary;
        const readVerdict = await port
          .verdict({ jobId: job.id, digest: job.digest, canary: job.canaryBatch })
          .catch((err) => {
            logger.error({ err, jobId: job.id }, "failed to read the fleet canary verdict");
            return { phase: "running" as CanaryPhase, detail: null };
          });
        const gate = canaryVerdict({
          phase: readVerdict.phase,
          canary: job.canaryBatch,
          rest: job.fleetRest,
          detail: readVerdict.detail ?? null,
        });
        if (gate.stopReason) {
          await completeCanary(job.id, "canary_failed", gate.stopReason);
          return;
        }
        if (!gate.proceed) return;
        if (job.fleetRest.length > 0) {
          try {
            await port.startRest({ jobId: job.id, digest: job.digest, rest: job.fleetRest });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await completeCanary(job.id, "canary_failed", `the canary batch was healthy but the rest could not be started: ${message}`);
            return;
          }
        }
        await completeCanary(job.id, "succeeded", gate.detail);
        return;
      }
      case "pending":
      case "verifying": {
        // Verification normally completes in create(); a restart left it here.
        const verification = await verifyImage(`${DEPLOY_IMAGE_REPOSITORY}@${job.digest}`, deps.probes);
        await applyVerification(job.id, verification);
        const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
        if (fresh && fresh.status === "verified") await awaitWindowOrEnter(fresh);
        return;
      }
      case "maintenance_entering": {
        const status = await deps.maintenance.status();
        const window = status.instance;
        if (!window) {
          // The window vanished (someone exited it by hand): retry once by
          // opening our own again; if that fails the job fails.
          await enterMaintenance(job);
          return;
        }
        if (window.state === "on") {
          await write((doc2) => {
            const current = doc2.jobs.find((j) => j.id === job.id);
            if (!current || current.status !== "maintenance_entering") return { next: null, result: null };
            const next = appendStep(
              { ...current, status: "maintenance_on", updatedAt: at.toISOString() },
              "maintenance_on",
              "maintenance window is on; host executor may switch the image",
              at,
            );
            return { next: updateJob(doc2, job.id, next), result: next.status };
          });
          return;
        }
        if (window.state === "leaving") {
          await failJob(job.id, "aborted", "maintenance window was exited while the deploy waited for it");
        }
        return;
      }
      case "maintenance_on": {
        // The host executor claims the job (phase claimed/switching) — the
        // board follows the report, it does not switch anything itself.
        const report = await deps.readHostReport(job.id).catch(() => null);
        if (!report) return; // the host has not picked the job up yet
        await write((doc2) => {
          const current = doc2.jobs.find((j) => j.id === job.id);
          if (!current || current.status !== "maintenance_on") return { next: null, result: null };
          const next = appendStep(
            { ...current, status: "running", updatedAt: at.toISOString() },
            "running",
            `host executor: ${report.phase}${report.detail ? ` (${report.detail})` : ""}`,
            at,
          );
          return { next: updateJob(doc2, job.id, next), result: next.status };
        });
        return;
      }
      case "running": {
        const report = await deps.readHostReport(job.id).catch(() => null);
        if (!report) return;
        if (report.phase === "health-ok") {
          const health = await deps.readHealth().catch(() => null);
          const healthy =
            health !== null &&
            (job.commit === null || health.commit === job.commit) &&
            (job.version === null || health.version === job.version);
          const nextStatus: DeployJobStatus = healthy ? "succeeded" : "failed_health";
          const detail = healthy
            ? `new image healthy: version ${health?.version ?? "<none>"}, commit ${health?.commit?.slice(0, 12) ?? "<none>"}`
            : `host reported health-ok but /api/health disagrees: got version ${health?.version ?? "<none>"}, commit ${health?.commit?.slice(0, 12) ?? "<none>"}`;
          if (!healthy && settings.autoRollback) {
            // R5-C: a failed health check with the automatic rollback on is
            // not terminal — the host executor rolls the image back next.
            await startAutoRollback(job, detail, report);
            return;
          }
          await finish(job.id, nextStatus, detail, report);
          return;
        }
        if (report.phase === "health-failed" || report.phase === "error") {
          const detail = `host executor failed: ${report.phase}${report.detail ? ` — ${report.detail}` : ""}`;
          if (settings.autoRollback) {
            // R5-C: same trigger — the new image is running but not healthy,
            // roll back to the locally remembered previous one.
            await startAutoRollback(job, detail, report);
            return;
          }
          await finish(job.id, "failed_health", detail, report);
          return;
        }
        // R5-C review fix: with AUTO_ROLLBACK on (the executor default) a
        // failed deploy never reports health-failed — the executor goes
        // straight to the rollback phases. The board must follow them from
        // `running` too: its tick can miss the intermediate phases entirely
        // (the rollback takes seconds, the tick is 5 s), and a job left in
        // `running` with a finished report hangs until the step timeout
        // aborts it with a false outcome.
        if (report.phase === "rolling-back") {
          const detail = `host executor: rolling back automatically${report.detail ? ` (${report.detail})` : ""}`;
          await startAutoRollback(job, detail, report);
          return;
        }
        if (report.phase === "rolled-back") {
          const detail = `rolled back to the previous image${report.detail ? ` (${report.detail})` : ""}`;
          if (!settings.autoRollback) {
            // Desync: the host rolled back with the board switch off. The
            // deploy still failed its health check — record it as such.
            await finish(job.id, "failed_health", `${detail}: the host executor rolled back with the board switch off`, report);
            return;
          }
          // The executor already closed the window itself (rollback.sh
          // leaves maintenance); finishRollback mirrors that for the case
          // the board never saw the intermediate phases.
          await startAutoRollback(job, detail, report);
          const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
          if (fresh && fresh.status === "rolling_back") {
            await finishRollback(job.id, "auto_rolled_back", detail, report);
          }
          return;
        }
        if (report.phase === "rollback-failed") {
          const reason = `the deploy failed and its rollback failed: ${report.detail ?? report.phase}`;
          const detail = `the automatic rollback failed: ${report.detail ?? report.phase}; maintenance stays on for the operator`;
          await startAutoRollback(job, reason, report);
          const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
          if (fresh && fresh.status === "rolling_back") {
            await finishRollback(job.id, "failed_rollback", detail, report);
          }
          return;
        }
        return; // claimed/switching/switched: still in progress
      }
      case "rolling_back": {
        // The host executor drives the rollback (rollback.sh, the remembered
        // previous image) and reports it; the board follows the report.
        const report = await deps.readHostReport(job.id).catch(() => null);
        if (!report) return;
        if (report.phase === "rolling-back") return; // in progress
        if (report.phase === "rolled-back") {
          const detail = `rolled back to the previous image${report.detail ? ` (${report.detail})` : ""}: ${job.failureReason ?? "the new image failed its health check"}`;
          await finishRollback(job.id, "auto_rolled_back", detail, report);
          return;
        }
        if (report.phase === "rollback-failed" || report.phase === "error") {
          const detail = `the automatic rollback failed: ${report.detail ?? report.phase}; maintenance stays on for the operator. ${job.failureReason ?? ""}`.trim();
          await finishRollback(job.id, "failed_rollback", detail, report);
          return;
        }
        return; // a stale earlier phase: wait for the rollback verdict
      }
      default:
        return;
    }
  }

  /**
   * R5-C: move a failed-health job to `rolling_back` and let the host
   * executor roll the board back. The failure reason of the deploy stays on
   * the job — `rolling_back` is the recovery of THAT failure, not a separate
   * job. The window stays on: it covers the rollback switch too.
   */
  async function startAutoRollback(job: DeployJob, reason: string, report: HostReport): Promise<void> {
    const at = now();
    const { result } = await write((doc) => {
      const current = doc.jobs.find((j) => j.id === job.id);
      if (!current || current.status !== "running") return { next: null, result: null as DeployJob | null };
      const next = appendStep(
        {
          ...current,
          status: "rolling_back",
          failureReason: reason,
          healthVersion: report.version ?? current.healthVersion,
          healthCommit: report.commit ?? current.healthCommit,
          updatedAt: at.toISOString(),
        },
        "rolling_back",
        `health check failed; rolling back automatically (${reason})`,
        at,
      );
      return { next: updateJob(doc, job.id, next), result: next };
    });
    if (!result) return;
    await auditFor(result, "rolling_back", { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { reason });
  }

  /** End a job whose rollback ran: success leaves the window, failure keeps it. */
  async function finishRollback(
    jobId: string,
    status: Extract<DeployJobStatus, "auto_rolled_back" | "failed_rollback">,
    detail: string,
    report: HostReport,
  ) {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "rolling_back") return { next: null, result: null as DeployJob | null };
      const next = appendStep(
        {
          ...job,
          status,
          // A successful rollback resolved the failed health check; a failed
          // rollback keeps the deploy's reason and adds its own on top.
          failureReason: status === "failed_rollback" ? detail : job.failureReason,
          updatedAt: at.toISOString(),
        },
        status,
        detail,
        at,
      );
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next };
    });
    if (!result) return;
    if (status === "auto_rolled_back") {
      await deps.maintenance.exit("deploy rolled back automatically").catch((err) => {
        logger.error({ err, jobId }, "failed to leave maintenance after the automatic rollback");
      });
    }
    await auditFor(result, status, { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { detail });
  }

  async function finish(jobId: string, status: Extract<DeployJobStatus, "succeeded" | "failed_health">, detail: string, report: HostReport) {
    // 1.7-AUTO-UPDATE-B (B-2): a healthy board switch is not the end of an
    // update — the fleet canary phase follows, and only it retires the job.
    // (A failed health check keeps the old path: the rollback owns it.)
    if (status === "succeeded") {
      await handToFleetCanary(jobId, detail, report);
      return;
    }
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "running") return { next: null, result: null as DeployJob | null };
      const next = appendStep(
        {
          ...job,
          status,
          healthVersion: report.version ?? null,
          healthCommit: report.commit ?? null,
          failureReason: detail,
          updatedAt: at.toISOString(),
        },
        status,
        detail,
        at,
      );
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next };
    });
    if (!result) return;
    // A failed health check keeps the window on for the rollback, the same
    // contract as deploy.sh step 7; the successful path never reaches here
    // (it hands the fleet to the canary phase above).
    await auditFor(result, status, { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { detail });
  }

  async function failJob(jobId: string, status: Extract<DeployJobStatus, "aborted" | "failed_health">, reason: string) {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || !isDeployJobActive(job.status)) return { next: null, result: null as DeployJob | null };
      const next = appendStep({ ...job, status, failureReason: reason, updatedAt: at.toISOString() }, status, reason, at);
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next };
    });
    if (!result) return;
    await deps.maintenance.exit(`deploy job ${status}`).catch((err) => {
      logger.error({ err, jobId }, "failed to leave maintenance after job failure");
    });
    await auditFor(result, status, { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { reason });
  }

  return {
    current: currentView,
    preview,
    create,
    abort,
    tick,
  };
}

export type DeployJobsService = ReturnType<typeof deployJobsService>;

// Re-export for the routes: the pure check the UI preview shares with create.
export { digestProblem, verifyCiImage };
