// server/src/myrmidon/bot-containers/routes.ts
//
// myrmidon(W2b): the API behind the "Container" section of the agent card.
//
//   GET  /api/myrmidon/agents/:id/bot-container/status
//   GET  /api/myrmidon/agents/:id/bot-container/git-store
//   POST /api/myrmidon/agents/:id/bot-container/apply
//   GET  /api/myrmidon/agents/:id/bot-container/apply/:applyId
//
// The apply is asynchronous (myrmidon(1.6.5 ASYNC-BOT-APPLY)): POST queues a
// job in bot_apply_jobs, answers 202 with the apply id in under a second, and
// the reconcile pass runs in the background of this same process; the status
// route reads the job row (database only, no runtime call), so the outcome —
// including the failure text — is visible even if this process dies next.
//
// All routes are gated behind MYRMIDON_BOT_CONTAINERS (off by default): while it is off,
// status still answers (so the card can say so) but reports `enabled: false` and
// never touches the container runtime, and apply is refused with 409. Board
// actors only — an agent never changes its own card or restarts its own gateway
// (same rule as agent-self-update.ts) — with ONE exception, myrmidon(1.6.5
// BOT-DISK-G live check): `git-store` is read-only facts about a bot's shared
// git-object store and answers an agent key of the same company, because the lead
// has no board-user channel and the attention feed is board-only.
//
// "Apply now" reconciles the SAVED card (applyBotContainerNow reads the agent row,
// not the form), so a card with unsaved edits has to be saved first; the UI
// enforces that. This file stays free of services/ imports: everything that
// needs the database or the maintenance service comes in through
// BotContainerRoutesDeps, so it can be tested with plain fakes (see index.ts for
// the real wiring).

import { Router, type Request } from "express";
import { conflict, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "../../routes/authz.js";
import { BOT_IMAGE_ALLOWLIST_ENV } from "./docker-driver.js";
import {
  botKeyForAgent,
  classifyBotImageTracking,
  isBotContainersEnabled,
  type BotImageTracking,
  readBotContainerAgentConfig,
} from "./agent-config.js";
import type { ApplyBotContainerOptions, ApplyBotContainerOutcome, BotContainerAgent, BotContainerRuntimeDeps } from "./index.js";
import type { BotApplyJobStore } from "./apply-jobs.js";
import type { BotApplyJobStatus } from "@paperclipai/db";
import {
  APPLIED_LIMIT_PENDING_NOTE,
  compareGatewayConcurrency,
  EXTERNAL_GATEWAY_NOTE,
  GATEWAY_RATE_LIMIT_LOOKBACK_MS,
  externalGatewayRateLimitWarning,
  NO_APPLIED_STATE_NOTE,
  type GatewayConcurrencyStatus,
} from "./concurrency-sync.js";
import { readMaxConcurrentRuns } from "./profile-input.js";
import { hasReleaseBotImage, resolveBotImageRolloutStatus, type BotImageRolloutStatus } from "@paperclipai/shared";
import {
  parseCloneReport,
  type GitRefCheck,
  type GitStoreState,
} from "./clone-hygiene.js";
import { isImageAllowed, parseImageAllowlist } from "./template.js";
import type { BotContainerState } from "./driver.js";

export interface BotContainerRouteAgent {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  /** The card's scheduling policy; read for heartbeat.maxConcurrentRuns. */
  runtimeConfig: Record<string, unknown>;
  /** myrmidon(BOT-ROLLOUT): the agent's lifecycle status (idle, paused, running, …) —
   *  the same value the rollout script reads off the agents list to decide a switch. */
  status?: string | null;
}

export interface BotContainerRoutesDeps {
  /** The stored agent row, or null. Reads the raw card: the apply reads the same. */
  getAgent(id: string): Promise<BotContainerRouteAgent | null>;
  /** Extra permission check for changing this agent's configuration; throws to deny. */
  assertCanUpdateAgent?(req: Request, agent: BotContainerRouteAgent): Promise<void>;
  /** The reconciler's runtime (driver, profile compiler, maintenance, network), or
   *  null while the instance has not wired one. */
  getRuntime(): BotContainerRuntimeDeps | null;
  /** applyBotContainerNow (index.ts). Injected, not imported: index.ts imports
   *  this file for its real wiring, and pulls in the services this file avoids. */
  applyNow(
    agent: BotContainerAgent,
    runtime: BotContainerRuntimeDeps,
    opts: ApplyBotContainerOptions,
  ): Promise<ApplyBotContainerOutcome>;
  /**
   * myrmidon(1.6.5 ASYNC-BOT-APPLY): the bot_apply_jobs journal. Required: the
   * apply route answers 202 only after the job row is durable, and the status
   * route reads the outcome only from this store.
   */
  applyJobs: Pick<BotApplyJobStore, "acquireLiveJob" | "markRunning" | "markSucceeded" | "markFailed" | "getJob">;
  /**
   * myrmidon(CONCURRENCY-SYNC): when this agent's most recent run failed with
   * GATEWAY_RATE_LIMITED_ERROR_CODE, at or after `sinceIso` — or null. Read only for
   * an agent whose gateway the board does not manage, where the board has no other
   * way to see that gateway is holding runs back. Optional: without it the status
   * simply carries no warning (tests, unwired deployments).
   */
  recentGatewayRateLimit?(
    agent: BotContainerRouteAgent,
    opts: { sinceIso: string },
  ): Promise<string | null>;
  /** Read per request; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface BotContainerStatusResponse {
  /** MYRMIDON_BOT_CONTAINERS is on for this instance. */
  enabled: boolean;
  /** The instance has a container runtime wired (driver and profile compiler). */
  runtimeConfigured: boolean;
  /** The saved card is an enabled, complete hermes_gateway container config. */
  eligible: boolean;
  /** Why the saved card is not eligible; null when it is. */
  reason: string | null;
  /** MYRMIDON_BOT_IMAGE_ALLOWLIST globs. Empty means no image is allowed at all. */
  imageAllowlist: string[];
  /** Whether the saved image matches the allowlist; null when there is no saved image. */
  imageAllowed: boolean | null;
  /** The live container, or null when it was not asked (flag off, no runtime, other adapter) or could not be. */
  container: { state: BotContainerState; image: string | null } | null;
  /** Set when the runtime was asked and did not answer. */
  containerError: string | null;
  /** myrmidon(1.6.4-BOT-CONTAINER-CARD): how the release bot-image rollout treats this bot:
   *  tracks the release, pinned (with the pinned image) or not applicable (with why). */
  imageTracking: BotImageTracking;
  /** myrmidon(BOT-ROLLOUT): the release bot-image rollout verdict of this bot —
   *  on the release image, or why not (busy / no release image configured /
   *  pinned / not applicable). Additive; absent on an older server. */
  imageRollout: BotImageRolloutStatus;
  /** myrmidon(CONCURRENCY-SYNC): runtimeConfig.heartbeat.maxConcurrentRuns, normalized
   *  exactly as the profile compiler normalizes it. Always answered, so the card can
   *  show the board's value even for a gateway the board does not manage. */
  boardMaxConcurrentRuns: number;
  /** Board value against the value the bot's applied profile carries. Null when there
   *  is no applied state to compare (no container yet, gateway not managed by the
   *  board, or the runtime did not answer) — see gatewayConcurrencyNote. */
  gatewayConcurrency: GatewayConcurrencyStatus | null;
  /** Why gatewayConcurrency is null, or a caveat about the value it carries. */
  gatewayConcurrencyNote: string | null;
  /** The gateway is limiting runs below the board's limit (unmanaged gateway with
   *  recently rate-limited runs). Null when there is nothing to warn about. */
  gatewayConcurrencyWarning: string | null;
}

export type BotContainerApplyResponse = { outcome: Exclude<ApplyBotContainerOutcome, { kind: "not_applicable" }> };

/**
 * myrmidon(1.6.5 ASYNC-BOT-APPLY): the 202 body of the apply POST — the id the
 * status route takes, plus the status the job already has (pending for a new
 * job; a live pending/running status when the POST reused one).
 */
export interface BotApplyAcceptedResponse {
  applyId: string;
  status: BotApplyJobStatus;
}

/** The GET status body: the job row, database-only. */
export interface BotApplyStatusResponse {
  status: BotApplyJobStatus;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * myrmidon(1.6.5 BOT-DISK-G live check): the facts of one bot's shared git-object
 * store, read from the report the in-container reporter already writes. The
 * acceptance of the OPE-5281 fix ("the second clone is small because the store
 * holds the objects") needs a channel an AGENT can read: the board's own
 * `GET /api/companies/:id/attention` is board-only (403 for an agent key), while
 * this route lives behind the same agents-table + company boundary as the status
 * route. Every field is answered — what is missing is explained in `note`, never
 * an error, so a reader does not have to interpret HTTP codes.
 */
export interface BotGitStoreResponse {
  /** MYRMIDON_BOT_CONTAINERS is on for this instance. */
  enabled: boolean;
  /** The instance has a container runtime wired (driver). */
  runtimeConfigured: boolean;
  /** The bot key of the container these facts belong to, when the agent has one. */
  botKey: string | null;
  /** The live container state; filled in only when the report was missing (to tell
   *  a stopped container from a silent reporter), else null. */
  containerState: BotContainerState | null;
  /** When the board read the report. */
  reportReadAtMs: number;
  /** The reporter's own `inspectedAt`; null when there is no usable report. */
  inspectedAtMs: number | null;
  /** How old the report is at read time; null when there is no usable report. */
  reportAgeMs: number | null;
  /** The store's facts, read live by the reporter (docker/bot-runtime/git-reference/
   *  bot-clone-hygiene); null when the report carries none. */
  gitStore: GitStoreState | null;
  /** The container-start self-check, with its own start-time store snapshot
   *  (`storeState`) — the fallback when the reporter is silent but the store was
   *  measured at the last start. */
  gitRefCheck: GitRefCheck | null;
  /** Why a field above is null; null when everything answered. */
  note: string | null;
}

/** Why the git-store facts are absent, in the words the reader needs. */
export const GIT_STORE_NOTE_FLAG_OFF =
  "Bot containers are not enabled on this instance (MYRMIDON_BOT_CONTAINERS): there is no per-bot git store to read.";
export const GIT_STORE_NOTE_NO_RUNTIME = "The bot container runtime is not configured on this instance.";
export const GIT_STORE_NOTE_NOT_A_BOT = "This agent has no bot container of its own (not a hermes_gateway agent with a bot key).";
export const GIT_STORE_NOTE_NO_READER = "The configured container driver cannot read the clone-hygiene report.";
export const GIT_STORE_NOTE_NO_REPORT =
  "The container holds no usable clone-hygiene report: not written yet, older than 24 hours, or malformed.";
export const GIT_STORE_NOTE_NO_STORE_FACTS =
  "The report carries no gitStore facts: the bot runs an image (or a reporter) older than the 1.6.5 shared-objects live check.";
export const GIT_STORE_NOTE_READ_FAILED = "The container runtime did not answer while reading the clone-hygiene report.";

const MAX_MESSAGE_CHARS = 500;

function clip(message: string): string {
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
}

export function botContainerRoutes(deps: BotContainerRoutesDeps) {
  const router = Router();
  const envNow = () => deps.env ?? process.env;

  /** 404 for both "no such agent" and "someone else's agent", so ids cannot be probed across companies. */
  async function loadAgent(req: Request): Promise<BotContainerRouteAgent> {
    const agent = await deps.getAgent(req.params.id as string);
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    return agent;
  }

  router.get("/myrmidon/agents/:id/bot-container/status", async (req, res) => {
    assertBoard(req);
    const agent = await loadAgent(req);
    const env = envNow();
    const enabled = isBotContainersEnabled(env);
    const allowlist = parseImageAllowlist(env[BOT_IMAGE_ALLOWLIST_ENV]);
    const parsed = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
    const savedImage = (agent.adapterConfig.container as { image?: unknown } | undefined)?.image;
    const runtime = deps.getRuntime();

    const body: BotContainerStatusResponse = {
      enabled,
      runtimeConfigured: runtime !== null,
      eligible: parsed.ok,
      reason: parsed.ok ? null : parsed.reason,
      imageAllowlist: allowlist,
      imageAllowed:
        agent.adapterType === "hermes_gateway" && typeof savedImage === "string" && savedImage.trim().length > 0
          ? isImageAllowed(savedImage.trim(), allowlist)
          : null,
      container: null,
      containerError: null,
      imageTracking: classifyBotImageTracking(agent.adapterType, agent.adapterConfig),
      // myrmidon(BOT-ROLLOUT): the verdict reads the card's tracking category and
      // the agent's status (the same source the rollout script uses) — no docker
      // query beyond the container status below.
      imageRollout: resolveBotImageRolloutStatus({
        tracking: classifyBotImageTracking(agent.adapterType, agent.adapterConfig),
        agentStatus: agent.status ?? null,
        hasReleaseImage: hasReleaseBotImage(env),
      }),
      boardMaxConcurrentRuns: readMaxConcurrentRuns(agent.runtimeConfig),
      gatewayConcurrency: null,
      gatewayConcurrencyNote: null,
      gatewayConcurrencyWarning: null,
    };

    const botKey = botKeyForAgent(agent.id);
    // Asked even when the card says "disabled": a container may still be running from before.
    if (enabled && runtime && botKey && agent.adapterType === "hermes_gateway") {
      try {
        const status = await runtime.driver.status(botKey);
        body.container = { state: status.state, image: status.image ?? null };
        // myrmidon(CONCURRENCY-SYNC): the applied limit, as recorded by the last apply's
        // marker. Only a container that exists can carry one.
        if (status.state !== "missing") {
          body.gatewayConcurrency = compareGatewayConcurrency({
            board: body.boardMaxConcurrentRuns,
            applied: status.maxConcurrentRuns ?? null,
            checkedAt: new Date().toISOString(),
          });
          if (status.maxConcurrentRuns === undefined) body.gatewayConcurrencyNote = APPLIED_LIMIT_PENDING_NOTE;
        }
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "bot container status query failed");
        body.containerError = "The container runtime did not answer.";
      }
    }

    // The board's own value against the gateway's — or why there is nothing to compare.
    // Applies to hermes_gateway agents only: no other adapter has this gateway limit.
    if (agent.adapterType === "hermes_gateway" && body.containerError === null && body.gatewayConcurrency === null) {
      if (!parsed.ok) {
        // No container is managed here: the gateway runs outside the board, which can
        // neither read nor apply its limit. The only outward sign is the runs the
        // gateway itself refused with 429 (see concurrency-sync.ts).
        body.gatewayConcurrencyNote = EXTERNAL_GATEWAY_NOTE;
        if (body.boardMaxConcurrentRuns > 1 && deps.recentGatewayRateLimit) {
          const sinceIso = new Date(Date.now() - GATEWAY_RATE_LIMIT_LOOKBACK_MS).toISOString();
          body.gatewayConcurrencyWarning = externalGatewayRateLimitWarning({
            board: body.boardMaxConcurrentRuns,
            rateLimitedAt: await deps.recentGatewayRateLimit(agent, { sinceIso }),
          });
        }
      } else {
        // Eligible card, no container yet (first apply pending, or the instance has no
        // runtime / the flag is off): nothing has been applied, so nothing to compare.
        body.gatewayConcurrencyNote = NO_APPLIED_STATE_NOTE;
      }
    }

    res.json(body);
  });

  /**
   * The background pass of one apply job. Every path ends in a journal write:
   * the pass's own error outcome lands in `error`, an exception thrown by the
   * reconciler or by the journal itself is caught here and recorded — nothing
   * escapes this function as an unhandled rejection, and nothing is lost.
   */
  async function runApplyJob(
    jobId: string,
    agent: BotContainerRouteAgent,
    runtime: BotContainerRuntimeDeps,
    env: NodeJS.ProcessEnv,
    applyDeps: BotContainerRoutesDeps,
  ): Promise<void> {
    try {
      await applyDeps.applyJobs.markRunning(jobId);
      const outcome = await applyDeps.applyNow(
        { agentId: agent.id, adapterType: agent.adapterType, adapterConfig: agent.adapterConfig },
        runtime,
        // myrmidon(1.6.5 ASYNC-BOT-APPLY): the button asks for a pass NOW; the freshness
        // reuse of the sweep/canary paths must not answer it with "recent_pass".
        { env, force: true },
      );
      if (outcome.kind === "error") {
        await applyDeps.applyJobs.markFailed(jobId, clip(outcome.message));
        return;
      }
      if (outcome.kind === "not_applicable") {
        // The card stopped being applicable between the POST check and the
        // pass (edited away, agent gone). That is a failure the presser needs
        // to see, not a silent success.
        await applyDeps.applyJobs.markFailed(jobId, clip(outcome.reason));
        return;
      }
      await applyDeps.applyJobs.markSucceeded(jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await applyDeps.applyJobs.markFailed(jobId, clip(message));
      } catch (journalErr) {
        // The journal itself is unreachable: log with the original cause, the
        // one thing left to do — the rejection still must not escape.
        logger.error({ err: journalErr, jobId, applyError: message }, "bot apply job failed AND its journal write failed");
      }
    }
  }

  /**
   * myrmidon(1.6.5 ASYNC-BOT-APPLY): "Apply now" is queued, not awaited. The
   * cheap validations (flag, runtime, saved-card applicability) stay inline —
   * they answer exactly as the synchronous route did — then one row lands in
   * bot_apply_jobs and the answer is 202 + applyId in well under a second. The
   * reconcile pass itself runs in the background of this process; its outcome
   * (including the error text) is written to the job row and read back through
   * the status route below. A live job for the same bot is returned as-is, so
   * a double click queues one pass, not two.
   */
  router.post("/myrmidon/agents/:id/bot-container/apply", async (req, res) => {
    assertBoard(req);
    const agent = await loadAgent(req);
    await deps.assertCanUpdateAgent?.(req, agent);
    const env = envNow();
    if (!isBotContainersEnabled(env)) {
      throw conflict("Bot containers are not enabled on this instance", { code: "bot_containers_disabled" });
    }
    const runtime = deps.getRuntime();
    if (!runtime) {
      // Answered directly, not thrown: the shared error handler reports every
      // thrown 5xx as a crash, and this is a configuration state, not a fault.
      res.status(503).json({
        error: "The bot container runtime is not configured on this instance",
        code: "bot_container_runtime_unavailable",
      });
      return;
    }
    // Applicability is a property of the SAVED card and is readable without
    // touching the runtime — the same read applyBotContainerNow starts with:
    // refuse a card that cannot apply with the same 409 as the synchronous
    // route did, instead of journaling a job that is known to fail.
    const parsed = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
    if (!parsed.ok) {
      throw conflict(clip(parsed.reason), { code: "bot_container_not_applicable" });
    }
    const job = await deps.applyJobs.acquireLiveJob({
      companyId: agent.companyId,
      botId: agent.id,
      requestedBy: req.actor.userId ?? null,
    });
    if (job.created) {
      // Fire-and-forget, but never unhandled: runApplyJob catches everything
      // and records the outcome on the job row; this catch only logs a failure
      // of its own error handling (the journal being unreachable twice over).
      runApplyJob(job.id, agent, runtime, env, deps).catch((err) => {
        logger.error({ err, jobId: job.id }, "bot apply job background task failed outside its own error handling");
      });
    }
    res.status(202).json({ applyId: job.id, status: job.status } satisfies BotApplyAcceptedResponse);
  });

  /**
   * myrmidon(1.6.5 ASYNC-BOT-APPLY): the outcome of one apply job, read from
   * the database only (no runtime call), so it answers while a pass is still
   * running and stays readable after the process moved on. Board actor only,
   * like the POST; the job is looked up under the agent's company boundary.
   */
  router.get("/myrmidon/agents/:id/bot-container/apply/:applyId", async (req, res) => {
    assertBoard(req);
    const agent = await loadAgent(req);
    const job = await deps.applyJobs.getJob({ botId: agent.id, jobId: req.params.applyId as string });
    if (!job) throw notFound("Apply job not found");
    res.json({
      status: job.status,
      error: job.error,
      startedAt: job.startedAt ? job.startedAt.toISOString() : null,
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    } satisfies BotApplyStatusResponse);
  });

  /**
   * myrmidon(1.6.5 BOT-DISK-G live check, OPE-5281 ч.B): the shared git-object
   * store's facts for one bot, for a reader with an AGENT key.
   *
   * Deliberately no assertBoard — unlike status/apply, which only a board user
   * calls: the lead has no board-user channel, and the board's attention feed
   * (GET /api/companies/:id/attention) answers an agent key with 403. loadAgent
   * keeps the company boundary and the "no oracle on ids" rule.
   *
   * Read-only, and the cheapest read there is: no docker exec, just the report
   * file the in-container reporter already writes (driver.readCloneReport), so
   * asking on every acceptance run costs the bot nothing. A missing report is
   * answered with 200 plus `note` (and the container state, to tell a stopped bot
   * from a silent reporter) rather than an error: what the reader needs is the
   * reason, not a status code to decode.
   */
  router.get("/myrmidon/agents/:id/bot-container/git-store", async (req, res) => {
    const agent = await loadAgent(req);
    const runtime = deps.getRuntime();
    const botKey = botKeyForAgent(agent.id);
    const readAtMs = Date.now();
    const body: BotGitStoreResponse = {
      enabled: isBotContainersEnabled(envNow()),
      runtimeConfigured: runtime !== null,
      botKey,
      containerState: null,
      reportReadAtMs: readAtMs,
      inspectedAtMs: null,
      reportAgeMs: null,
      gitStore: null,
      gitRefCheck: null,
      note: null,
    };
    if (!body.enabled) {
      body.note = GIT_STORE_NOTE_FLAG_OFF;
    } else if (!runtime) {
      body.note = GIT_STORE_NOTE_NO_RUNTIME;
    } else if (!botKey || agent.adapterType !== "hermes_gateway") {
      body.note = GIT_STORE_NOTE_NOT_A_BOT;
    } else if (!runtime.driver.readCloneReport) {
      body.note = GIT_STORE_NOTE_NO_READER;
    } else {
      try {
        const raw = await runtime.driver.readCloneReport(botKey);
        const report = raw === null ? null : parseCloneReport(raw, readAtMs);
        if (report) {
          body.inspectedAtMs = report.inspectedAtMs;
          body.reportAgeMs = Math.max(0, readAtMs - report.inspectedAtMs);
          body.gitStore = report.gitStore;
          body.gitRefCheck = report.gitRefCheck;
          // Honest at field level: a report from an image older than this change
          // is still a report, but it carries no store facts to accept on.
          if (!body.gitStore && !body.gitRefCheck?.storeState) body.note = GIT_STORE_NOTE_NO_STORE_FACTS;
        } else {
          body.note = GIT_STORE_NOTE_NO_REPORT;
          try {
            body.containerState = (await runtime.driver.status(botKey)).state;
          } catch (err) {
            logger.warn({ err, agentId: agent.id }, "bot container status query failed for the git-store facts");
          }
        }
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "bot container git-object store facts read failed");
        body.note = GIT_STORE_NOTE_READ_FAILED;
      }
    }
    res.json(body);
  });

  return router;
}
