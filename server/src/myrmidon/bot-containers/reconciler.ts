// server/src/myrmidon/bot-containers/reconciler.ts
//
// Applies a compiled hermes profile to one bot's container. Design:
// containers-plan-senior-2026-09-28.md §2.2.
//
//   missing  -> create (volumes prepared, container NOT started) -> writeProfile
//               -> start (waits for health). The gateway never boots without its
//               profile, and a failed step leaves a stopped container whose
//               missing marker makes the next pass write the profile again.
//               An image that does not declare the bot runtime contract
//               (template.ts BOT_RUNTIME_CONTRACT_LABEL: API_SERVER_KEY from
//               hermes/.env, among others) is refused before anything exists,
//               so no pass creates a container whose gateway cannot start.
//   stopped  -> nothing can be running in it, so no maintenance window: recreate
//               if the template drifted, write the profile if it changed (or was
//               never verifiably applied), then start.
//   running / unhealthy (live) — anything that stops the gateway goes through
//               R3 (pause admission for this agent alone, wait for its running
//               work to drain, apply, resume):
//     template drift          -> recreate (+ writeProfile if changed) + start
//     restart class           -> writeProfile + restart
//     unhealthy (any class)   -> writeProfile if changed + restart
//     files class, running    -> writeProfile only, no restart, no window
//     none, running           -> nothing
//
// "Unhealthy" is Docker's own health verdict (the image's HEALTHCHECK after its
// retries), see docker-driver.ts botStateFromInspect — never one failed probe.
//
// R3 windows this reconciler did not open are left alone: if the agent is
// already under a maintenance window someone else opened (an operator, say), a
// change that needs one is deferred to a later pass instead of being applied
// inside — and then closing — that window.
//
// Errors never escape reconcileBot: every failure is caught, written to the
// injected activity sink, and returned as `{kind: "error"}` — a bad reconcile pass
// for one bot must not take the sweep in index.ts down with it.

import { classifyProfileChange, type CompiledProfile, type ProfileChangeClass } from "./types.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerState } from "./driver.js";
import type { BackimportSummary, BotSkillBackimportPorts } from "./skill-backimport.js";
import { backimportBotSkills, isBotSkillBackimportEnabled } from "./skill-backimport.js";

export type MaintenanceWindowState = "entering" | "on" | "leaving" | "off";

export interface MaintenanceWindowView {
  state: MaintenanceWindowState;
  runningRuns: number;
}

export interface MaintenanceEnterResult extends MaintenanceWindowView {
  /** True when the window belongs to this reconciler: this very call opened it,
   *  or it is one the reconciler itself opened earlier and never got to close
   *  (same system actor). False for a window anyone else opened — the
   *  reconciler must neither apply inside it nor exit it. */
  owned: boolean;
}

/**
 * The slice of maintenance mode (R3, server/src/myrmidon/maintenance) the
 * reconciler needs, scoped to one agent. index.ts adapts the real
 * `maintenanceService` to this port; tests use a fake.
 */
export interface BotMaintenancePort {
  /** Opens an agent-scoped window, or returns the one already open for this
   *  agent (maintenanceService.enter does not replace an existing window). */
  enter(agentId: string, reason: string, drainTimeoutSec: number): Promise<MaintenanceEnterResult>;
  status(agentId: string): Promise<MaintenanceWindowView>;
  exit(agentId: string, reason: string): Promise<void>;
}

export interface BotContainerActivitySink {
  record(entry: {
    level: "info" | "error";
    agentId: string;
    botKey: string;
    message: string;
    details?: Record<string, unknown>;
  }): void | Promise<void>;
}

const noopActivitySink: BotContainerActivitySink = { record: () => {} };

export interface ReconcileBotInput {
  agentId: string;
  botKey: string;
  spec: BotContainerSpec;
  /** Produces the bot's compiled profile (compileHermesProfile, G2). The
   *  reconciler only ever needs the resulting CompiledProfile. */
  compile: () => Promise<CompiledProfile>;
  driver: BotContainerDriver;
  maintenance: BotMaintenancePort;
  activity?: BotContainerActivitySink;
  /** Seconds R3 waits for this agent's in-flight runs to drain before its own
   *  background tick starts interrupting them (see maintenance/service.ts
   *  `decideTick`/`interruptRuns`). Defaults to DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC. */
  maintenanceDrainTimeoutSec?: number;
  /** Test hook: replaces the real delay between drain polls. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401): the company catalog side
   * of the bot-skill back-import, with the company this agent belongs to.
   * Read per pass; both absent (or the flag off) = the pass is exactly what
   * it was before the feature existed. A present pair with the flag on reads
   * the bot's own skills out of the container (driver.readBotSkills) after
   * the container is up with its profile applied, and upserts the new and
   * changed ones into the catalog; the next pass's profile then delivers
   * them back to the bots the lifecycle selects. A driver without
   * readBotSkills (fleetd) silently keeps no back-import.
   */
  backimport?: { companyId: string; ports: BotSkillBackimportPorts };
  /** Read per pass; defaults to process.env. Carries MYRMIDON_BOT_SKILL_BACKIMPORT. */
  env?: NodeJS.ProcessEnv;
}

export type ReconcileOutcome =
  | { kind: "created" }
  | { kind: "applied_files" }
  | { kind: "applied_restart" }
  | { kind: "unchanged" }
  | { kind: "deferred"; reason: string }
  | { kind: "error"; message: string };

export const DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC = 300;
const DRAIN_POLL_INTERVAL_MS = 2_000;
/** How much longer than the drain timeout the reconciler keeps polling before
 *  giving up: R3's own tick (already running server-wide, started by
 *  startMaintenanceMode at boot) is what actually interrupts runs past the
 *  deadline, and it only checks on its own interval — this is slack for that, not
 *  a second timeout the reconciler enforces itself. */
const DRAIN_POLL_GRACE_MS = 30_000;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PausedResult = { kind: "applied" } | { kind: "deferred"; reason: string };

/**
 * Runs `apply` with admission paused for `agentId` alone (R3, scope "agent"),
 * after its running work has drained. Exits the window on the way out — even
 * when `apply` or the drain wait throws — but only a window this reconciler
 * owns; a window someone else opened is neither used nor closed (deferred).
 */
async function withAgentPaused(
  params: {
    agentId: string;
    botKey: string;
    reason: string;
    maintenance: BotMaintenancePort;
    drainTimeoutSec: number;
    sleep: (ms: number) => Promise<void>;
    activity: BotContainerActivitySink;
  },
  apply: () => Promise<void>,
): Promise<PausedResult> {
  const { agentId, botKey, reason, maintenance, drainTimeoutSec, sleep, activity } = params;
  const entered = await maintenance.enter(agentId, reason, drainTimeoutSec);
  if (!entered.owned) {
    return {
      kind: "deferred",
      reason: "the agent is under a maintenance window the bot container reconciler did not open; retrying on a later pass",
    };
  }
  try {
    const drain = await waitForZeroRunning(maintenance, agentId, drainTimeoutSec, sleep);
    if (drain.chatPreempted) {
      // myrmidon(CHAT-FIRST, OPE-3638): the owner started a chat turn inside
      // the window. Defer the profile update; the finally below exits the
      // window at once so nothing else is held either.
      return {
        kind: "deferred",
        reason: "the bot owner is in a chat conversation; the profile update is deferred to a later pass",
      };
    }
    if (!drain.drained) {
      throw new Error(`agent ${agentId} still had running work after the maintenance drain timeout`);
    }
    await apply();
    return { kind: "applied" };
  } finally {
    await maintenance.exit(agentId, reason).catch((err: unknown) => {
      void activity.record({
        level: "error",
        agentId,
        botKey,
        message: "failed to exit bot container maintenance window",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  }
}

/**
 * myrmidon(APPLY-LOG): the created branch reads no drift report and no change
 * class — a container that does not exist has nothing to compare against — so
 * its trigger names its own shape instead of inventing two comparable states.
 */
const CREATED_TRIGGER = "missing:new";

/**
 * myrmidon(APPLY-LOG): the one field that answers "why did this pass apply
 * anything" for a single record — the container state the pass read, whether
 * the template had drifted, and the profile change class
 * ("running:nodrift:restart"). Without it the reason for a restart is spread
 * over two or three separate records, and a restart-class change with no drift
 * states it nowhere at all.
 */
function applyTrigger(state: BotContainerState, drifted: boolean, changeClass: ProfileChangeClass): string {
  return `${state}:${drifted ? "drift" : "nodrift"}:${changeClass}`;
}

/**
 * myrmidon(APPLY-LOG): the diagnostic tail every apply-branch info record
 * carries — the hashes of the profile this pass wrote, the concurrency limit the
 * compiled profile hands the gateway, and the trigger. `maxConcurrentRuns` is
 * optional on a compiled profile: an absent key means "this profile does not set
 * one", never a default the profile does not carry.
 */
function appliedDetails(profile: CompiledProfile, trigger: string): Record<string, unknown> {
  return {
    restartHash: profile.restartHash,
    appliedFilesHash: profile.filesHash,
    ...(profile.maxConcurrentRuns === undefined ? {} : { appliedMaxConcurrentRuns: profile.maxConcurrentRuns }),
    trigger,
  };
}

export async function reconcileBot(input: ReconcileBotInput): Promise<ReconcileOutcome> {
  const { agentId, botKey, spec, compile, driver, maintenance } = input;
  const activity = input.activity ?? noopActivitySink;
  const sleep = input.sleep ?? realSleep;
  const drainTimeoutSec = input.maintenanceDrainTimeoutSec ?? DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_SEC;
  const info = (message: string, details?: Record<string, unknown>) =>
    activity.record({ level: "info", agentId, botKey, message, details });

  /**
   * myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401): reads the bot's own
   * skills out of the container and upserts the new/changed ones into the
   * company catalog. Runs only where the pass already left the container
   * running with its profile applied (the calls above), so the read always
   * answers the state the bot actually worked in. Gated on
   * MYRMIDON_BOT_SKILL_BACKIMPORT (default off = the pass is exactly what it
   * was), on a driver that can read the container filesystem, and on the
   * catalog ports being wired — all three absent/off = previous behavior.
   * Never throws: a failed import is a recorded activity entry, not a failed
   * reconcile (the bot's own work must not pay for the bookkeeping).
   */
  const backimportBotSkillsIntoCatalog = async (): Promise<void> => {
    const target = input.backimport;
    if (!target || !driver.readBotSkills) return;
    if (!isBotSkillBackimportEnabled(input.env ?? process.env)) return;
    try {
      const directories = await driver.readBotSkills(botKey);
      if (directories === null || directories.length === 0) return;
      const summary: BackimportSummary = await backimportBotSkills(target.companyId, directories, target.ports);
      const created = summary.imported.filter((r) => r.outcome === "created").length;
      const updated = summary.imported.filter((r) => r.outcome === "updated").length;
      const unchanged = summary.imported.filter((r) => r.outcome === "unchanged").length;
      const failed = summary.failed.length;
      if (created > 0 || updated > 0 || failed > 0) {
        await info("bot skills back-imported into the company catalog", {
          created,
          updated,
          unchanged,
          failed,
          failedDetails: summary.failed,
        });
      }
    } catch (err) {
      await activity.record({
        level: "error",
        agentId,
        botKey,
        message: "bot skill back-import failed (the reconcile itself succeeded)",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  try {
    // myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): when the driver can answer status
    // and drift from one inspect (docker-driver's statusWithDrift), do that —
    // the separate status + templateDrift pair cost two A2 inspects per bot per
    // pass, which alone put the 74-bot sweep over the planned request budget.
    // A driver without the probe (fleetd) keeps the old pair.
    const probed = driver.statusWithDrift ? await driver.statusWithDrift(spec) : null;
    const status = probed ? probed.status : await driver.status(botKey);

    if (status.state === "missing") {
      const profile = await compile();
      await driver.create(spec);
      await driver.writeProfile(botKey, profile);
      await driver.start(botKey);
      await backimportBotSkillsIntoCatalog();
      await info("bot container created and profile applied", appliedDetails(profile, CREATED_TRIGGER));
      return { kind: "created" };
    }

    const profile = await compile();
    // Side-effect free; a drift is only ever applied below, through recreate.
    // myrmidon(OPE-4789): the status read above carries the container's own
    // inspect; handing it in keeps one pass at one inspect instead of two.
    const drift = probed ? probed.drift : await driver.templateDrift(spec, status);
    const drifted = drift.drifted;
    if (drifted) {
      // Names the field and both values, so a drift is diagnosable from the
      // log alone — the 01.10 incident recreated every bot every pass with a
      // message that named none of them.
      await info("bot container template drift detected", { fields: drift.fields });
    }
    // Hashes come only from the applied-state marker; none there means nothing
    // verified applied, which classifies as "restart", never "none".
    const changeClass = classifyProfileChange({ restartHash: status.restartHash, filesHash: status.filesHash }, profile);

    if (status.state === "stopped") {
      if (drifted) await driver.recreate(spec);
      if (changeClass !== "none") await driver.writeProfile(botKey, profile);
      await driver.start(botKey);
      await info("stopped bot container brought up", {
        drifted,
        changeClass,
        ...appliedDetails(profile, applyTrigger(status.state, drifted, changeClass)),
      });
      await backimportBotSkillsIntoCatalog();
      return { kind: "applied_restart" };
    }

    if (status.state === "running" && !drifted) {
      if (changeClass === "none") {
        await backimportBotSkillsIntoCatalog();
        return { kind: "unchanged" };
      }
      if (changeClass === "files") {
        await driver.writeProfile(botKey, profile);
        await info(
          "bot container profile files applied without restart",
          appliedDetails(profile, applyTrigger(status.state, drifted, changeClass)),
        );
        await backimportBotSkillsIntoCatalog();
        return { kind: "applied_files" };
      }
    }

    // Live container and the gateway has to go down: template drift, a
    // restart-class change, or Docker's health check gave up on it.
    const reason = drifted
      ? `bot container template update (${botKey})`
      : status.state === "unhealthy"
        ? `bot container health recovery (${botKey})`
        : `bot container profile update (${botKey})`;
    const result = await withAgentPaused({ agentId, botKey, reason, maintenance, drainTimeoutSec, sleep, activity }, async () => {
      if (drifted) {
        await driver.recreate(spec);
        if (changeClass !== "none") await driver.writeProfile(botKey, profile);
        await driver.start(botKey);
        return;
      }
      if (changeClass !== "none") await driver.writeProfile(botKey, profile);
      await driver.restart(botKey); // resolves once the gateway reports healthy, or throws
    });
    // The window's own reason is what maintenance.enter received; the deferred
    // record's `reason` is the outcome explanation, so they carry different keys.
    const trigger = applyTrigger(status.state, drifted, changeClass);
    if (result.kind === "deferred") {
      await info("bot container update deferred", {
        reason: result.reason,
        drifted,
        changeClass,
        state: status.state,
        trigger,
        maintenanceReason: reason,
      });
      return result;
    }
    await info(
      drifted
        ? "bot container recreated for a template change (image, resource limits or network)"
        : status.state === "unhealthy"
          ? "unhealthy bot container restarted"
          : "bot container restarted with updated profile",
      { drifted, changeClass, previousState: status.state, maintenanceReason: reason, ...appliedDetails(profile, trigger) },
    );
    await backimportBotSkillsIntoCatalog();
    return { kind: "applied_restart" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await activity.record({ level: "error", agentId, botKey, message: "bot container reconcile failed", details: { error: message } });
    return { kind: "error", message };
  }
}

async function waitForZeroRunning(
  maintenance: BotMaintenancePort,
  agentId: string,
  drainTimeoutSec: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ drained: boolean; chatPreempted?: boolean }> {
  const deadline = Date.now() + drainTimeoutSec * 1000 + DRAIN_POLL_GRACE_MS;
  // myrmidon(CHAT-FIRST, OPE-3638): the owner's chat turn outranks the profile
  // update. The admission gate lets a user-authored chat wake start inside
  // this window (the only wake it lets through), so a rising running-count
  // mid-drain means the owner is in chat right now: stop waiting, leave the
  // window (the caller's finally exits it), and retry the update on the next
  // sweep instead of interrupting their turn at the drain deadline.
  let minRunning = Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    const view = await maintenance.status(agentId);
    if (view.runningRuns === 0) return { drained: true };
    if (view.runningRuns > minRunning) return { drained: false, chatPreempted: true };
    minRunning = Math.min(minRunning, view.runningRuns);
    await sleep(DRAIN_POLL_INTERVAL_MS);
  }
  const last = await maintenance.status(agentId);
  if (last.runningRuns === 0) return { drained: true };
  if (last.runningRuns > minRunning) return { drained: false, chatPreempted: true };
  return { drained: false };
}
