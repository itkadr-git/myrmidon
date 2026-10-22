// server/src/myrmidon/bot-containers/deferred-reconciler.ts
//
// myrmidon(BOT-ROLLOUT): the deferred-rollout watcher. A reconcile pass that
// had a real change to apply but could not touch the live container (the
// agent was busy: someone else's maintenance window, or the owner in a chat
// conversation) left a record in the `myrmidonBotRolloutDeferred` key of
// instance_settings.general (deferred-store.ts, written by index.ts). This
// module is what makes that drift converge WITHOUT the next deploy: it runs
// once per reconciliation sweep (one marked call inside
// startBotContainerReconciliation's tick, after the regular passes) and
// retries the apply of every recorded bot.
//
// The rules, per record:
//  - busy  (maintenance status reports running work, the rollout's own busy
//    signal): nothing this tick — the record keeps waiting;
//  - free  (no running work) or under a maintenance window (paused): retry
//    `applyBotContainerNow` right away; a successful outcome (or
//    `not_applicable`: the agent is gone or its container is off) removes
//    the record — the bot is on the new image without a new deploy;
//  - stuck longer than MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC (default
//    3600): the soft timeout — the retry goes WITHOUT the busy gate, i.e.
//    applyBotContainerNow runs its own existing pause-and-apply path: it
//    opens an agent maintenance window, drains the in-flight run to its end
//    (never interrupts it — OPE-3638), then recreates the container. The
//    bot switches right after the current turn instead of waiting however
//    long a permanently busy bot would otherwise wait;
//  - older than DEFERRED_GRACE_FACTOR × maxWait (the backstop): the record
//    never managed to apply — it is marked with an error and retired
//    (dropped), and an audit/activity event is written, so a wedged record
//    does not retry forever.
//
// The busy signal is `deps.maintenance.status(agentId).runningRuns` — the
// same port the reconcile path itself reads through withAgentPaused — so
// "busy" means the same thing here as in the rollout pass that deferred.
//
// The watcher never throws: one bad record must not fail the sweep, and the
// whole watcher is wrapped by the caller's own never-throw guard as well.

import type { Db } from "@paperclipai/db";
import {
  bumpBotRolloutDeferredAttempt,
  mutateBotRolloutDeferredDocument,
  readBotRolloutDeferredDocument,
  removeBotRolloutDeferredRecord,
  upsertBotRolloutDeferredRecord,
  type BotRolloutDeferredRecord,
} from "./deferred-store.js";
import type { BotContainerActivitySink, BotMaintenancePort } from "./reconciler.js";

export const BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV = "MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC";
export const DEFAULT_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC = 3600;
const MIN_MAX_WAIT_SEC = 60;
const MAX_MAX_WAIT_SEC = 86_400;

/** The backstop grace, in multiples of the max wait: 4×3600s = 4h by default. */
export const BOT_ROLLOUT_DEFERRED_GRACE_FACTOR = 4;

/** The watcher retries through the runtime the sweep already built; typing the
 *  two pieces it touches keeps this module free of the index.ts import cycle
 *  (index.ts calls the watcher, the watcher calls applyBotContainerNow). */
export interface DeferredRolloutRetryPort {
  (agent: { agentId: string; adapterType: string; adapterConfig: Record<string, unknown> }, opts: {
    force: boolean;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ kind: string; reason?: string; message?: string }>;
}

export interface DeferredRolloutWatcherDeps {
  maintenance: BotMaintenancePort;
  activity?: BotContainerActivitySink;
  /** index.ts passes applyBotContainerNow bound to the sweep's runtime deps. */
  applyNow: DeferredRolloutRetryPort;
  /** Reads one agent's card (the sweep runtime's readAgent): the retry is
   *  driven from the LIVE card, so a card changed since the deferral wins. */
  readAgent: (agentId: string) => Promise<{ agentId: string; adapterType: string; adapterConfig: Record<string, unknown> } | null>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Activity-log audit for the backstop retire; optional (tests inject a
   *  spy, startup wires logActivity). Best-effort: a failing audit never
   *  blocks the retire. */
  audit?: (entry: { companyId: string; action: string; entityId: string; agentId: string; details: Record<string, unknown> }) => Promise<void>;
  /** companyId lookup for the audit row (the record does not carry it). */
  companyIdOf?: (agentId: string) => Promise<string | null>;
}

/** The max wait before a deferred apply stops waiting for the bot to free
 *  itself (seconds). Unset, non-integer or out-of-range — the default. */
export function readBotRolloutDeferredMaxWaitSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]?.trim();
  if (!raw) return DEFAULT_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_MAX_WAIT_SEC || value > MAX_MAX_WAIT_SEC) {
    return DEFAULT_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC;
  }
  return value;
}

/** Outcomes after which the record is done: the change was applied (or there
 *  was verifiably nothing to apply), so the bot converged. `deferred`,
 *  `error` and `not_applicable` keep or drop the record per the caller. */
function appliedOutcome(kind: string): boolean {
  return kind === "created" || kind === "applied_files" || kind === "applied_restart" || kind === "unchanged";
}

/**
 * One watcher pass over the deferred records. Called from the sweep tick in
 * index.ts (myrmidon(BOT-ROLLOUT) marker) — never on its own schedule.
 * Records are processed sequentially: each retry takes the per-bot lock, and
 * one slow apply must not fan out into concurrent docker storms.
 */
export async function runDeferredRolloutWatcher(db: Db, deps: DeferredRolloutWatcherDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const maxWaitSec = readBotRolloutDeferredMaxWaitSec(deps.env ?? process.env);
  const maxWaitMs = maxWaitSec * 1000;
  const graceMs = BOT_ROLLOUT_DEFERRED_GRACE_FACTOR * maxWaitMs;
  const activity = deps.activity;
  const record0 = (level: "info" | "error", agentId: string, botKey: string, message: string, details?: Record<string, unknown>) =>
    activity?.record({ level, agentId, botKey, message, details });

  let records: BotRolloutDeferredRecord[];
  try {
    records = (await readBotRolloutDeferredDocument(db)).records;
  } catch (err) {
    await record0("error", "*", "*", "deferred bot rollout watcher could not read its records", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const record of records) {
    const at = now();
    const waitingMs = at.getTime() - Date.parse(record.firstDeferredAt);

    // Backstop first: a record that outlived the grace is retired loudly
    // instead of retrying once more forever.
    if (waitingMs >= graceMs) {
      const error = `deferred bot rollout apply did not converge within ${BOT_ROLLOUT_DEFERRED_GRACE_FACTOR}x the max wait (${graceMs / 1000}s)`;
      await retireRecord(db, record.botKey);
      await record0("error", record.agentId, record.botKey, error, {
        targetImage: record.targetImage,
        attempts: record.attempts,
        firstDeferredAt: record.firstDeferredAt,
      });
      if (deps.audit && deps.companyIdOf) {
        try {
          const companyId = await deps.companyIdOf(record.agentId);
          if (companyId) {
            await deps.audit({
              companyId,
              action: "myrmidon.bot_rollout.deferred_retired",
              entityId: record.botKey,
              agentId: record.agentId,
              details: { error, targetImage: record.targetImage, attempts: record.attempts, firstDeferredAt: record.firstDeferredAt },
            });
          }
        } catch {
          // best-effort audit: the retire itself already happened and is logged
        }
      }
      continue;
    }

    // The busy gate, unless the record already waited out the soft timeout:
    // past maxWait the retry goes without the gate and applyBotContainerNow's
    // own pause-and-apply path drains the bot after its current run ends.
    const gated = waitingMs < maxWaitMs;
    if (gated) {
      let busy: boolean | null = null;
      try {
        const view = await deps.maintenance.status(record.agentId);
        busy = view.runningRuns > 0;
      } catch (err) {
        await record0("error", record.agentId, record.botKey, "deferred bot rollout watcher could not read the busy signal; retrying next sweep", {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (busy) continue; // still working; the next sweep retries
    }

    const agent = await deps.readAgent(record.agentId).catch(() => null);
    if (!agent) {
      // The agent is gone (deleted) or unreadable: the reconcile sweep is the
      // authority on who exists — drop the record instead of retrying forever.
      await retireRecord(db, record.botKey);
      await record0("info", record.agentId, record.botKey, "deferred bot rollout record dropped: the agent is no longer reconciled");
      continue;
    }

    let outcome: { kind: string; reason?: string; message?: string };
    try {
      outcome = await deps.applyNow(agent, { force: true, env: deps.env });
    } catch (err) {
      // applyBotContainerNow never throws (reconcileBot catches); this guards
      // the paths around it so one bad record cannot fail the sweep.
      await record0("error", record.agentId, record.botKey, "deferred bot rollout retry threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (appliedOutcome(outcome.kind)) {
      await retireRecord(db, record.botKey);
      await record0("info", record.agentId, record.botKey, "deferred bot rollout applied; the bot switched without a new deploy", {
        outcome: outcome.kind,
        targetImage: record.targetImage,
        attempts: record.attempts + 1,
        waitedMs: waitingMs,
        ungated: !gated,
      });
      continue;
    }
    if (outcome.kind === "not_applicable") {
      // The card stopped qualifying (container off, another adapter): nothing
      // left to converge — the record is done.
      await retireRecord(db, record.botKey);
      await record0("info", record.agentId, record.botKey, "deferred bot rollout record dropped", { reason: outcome.reason ?? "" });
      continue;
    }
    // deferred or error: count the attempt and keep waiting (the backstop
    // bounds how long).
    const reason = outcome.kind === "deferred" ? (outcome.reason ?? "") : (outcome.message ?? "");
    await bumpAttempt(db, record.botKey, reason);
  }
}

async function retireRecord(db: Db, botKey: string): Promise<void> {
  await mutateBotRolloutDeferredDocument(db, (current) => ({
    next: removeBotRolloutDeferredRecord(current, botKey),
    result: null,
  })).catch(() => undefined);
}

async function bumpAttempt(db: Db, botKey: string, reason: string): Promise<void> {
  await mutateBotRolloutDeferredDocument(db, (current) => ({
    next: bumpBotRolloutDeferredAttempt(current, botKey, reason),
    result: null,
  })).catch(() => undefined);
}

/**
 * The write half of myrmidon(BOT-ROLLOUT) item 1, used by index.ts after a
 * pass: a deferred outcome with a drift-class change records itself;
 * a converging outcome removes the record. Both are idempotent (the pure
 * document steps in deferred-store.ts) and never throw: a store failure must
 * not change the pass's outcome.
 */
export async function recordBotRolloutDeferred(
  db: Db,
  entry: { botKey: string; agentId: string; targetImage: string; reason: string },
  now: Date = new Date(),
): Promise<void> {
  await mutateBotRolloutDeferredDocument(db, (current) => {
    const next = upsertBotRolloutDeferredRecord(current, entry, now);
    return { next, result: null };
  }).catch(() => undefined);
}

/** Same, removing the record of a bot whose pass converged. */
export async function clearBotRolloutDeferred(db: Db, botKey: string): Promise<void> {
  await mutateBotRolloutDeferredDocument(db, (current) => ({
    next: removeBotRolloutDeferredRecord(current, botKey),
    result: null,
  })).catch(() => undefined);
}
