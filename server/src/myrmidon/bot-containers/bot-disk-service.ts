// Bot draft-directory lifecycle settings (myrmidon BOT-DISK-A): read and change
// them without restarting the server.
//
// Contract: `instance_settings.general.botDisk` is the source of truth once an
// operator saves it; the environment stays the first-start default (see
// packages/shared/src/myrmidon-bot-disk.ts for the precedence and the value
// rules). A change writes the row and records it in the activity log for
// every company, the same way the runtime limits do. The sweep re-reads the
// row on every maintenance tick (see `resolveBotDiskLifecycleConfig`), so the
// next tick already uses the new values.
//
// Every request's read-write-audit sequence runs through one queue, so two
// overlapping PATCHes cannot commit in one order and audit in the other.

import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  BOT_DISK_LAYOUT_KEYS,
  botRoleGetsSharedCache,
  BOT_DISK_SETTING_KEYS,
  BOT_DISK_UPDATED_ACTION,
  botDiskPnpmWarnings,
  mergeBotDiskSettings,
  resolveBotDiskSettings,
  resolveBotDiskLayout,
  resolveSharedPackageCachePath,
  resolveSharedBotRuntimePath,
  type BotDiskLayout,
  type BotDiskSettings,
  type BotDiskSettingsPatch,
  type ResolvedBotDiskSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { sweepAllBotVolumes } from "./draft-lifecycle.js";
import { refreshGitMirrors } from "./git-mirror.js"; // myrmidon(1.6.2-BOT-DISK-C)
import { dropCloneSignalsExcept, ingestCloneReport, noteCloneReportSeen } from "./clone-hygiene.js";
import { getBotContainerRuntime } from "./routes-wiring.js";
import { botKeyForAgent, readBotContainerAgentConfig } from "./agent-config.js"; // myrmidon(1.6.4-BOT-CONTAINER-CARD)
import { botKeyLock, type BotKeyLock } from "./bot-key-lock.js"; // myrmidon(1.6.5-DOCKERGATE-A2A3-STORM)

export type BotDiskView = ResolvedBotDiskSettings;

/** Who changed the settings, for the activity log. */
export interface BotDiskActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type BotDiskAuditEntry = BotDiskActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface BotDiskServiceDeps {
  settings: {
    getGeneral(): Promise<{ botDisk?: unknown }>;
    updateGeneral(patch: { botDisk: BotDiskSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: BotDiskAuditEntry): Promise<unknown>;
  env?: Record<string, string | undefined>;
}

export interface BotDiskService {
  /** Effective settings and where each value came from. */
  read(): Promise<BotDiskView>;
  /** Persist and audit a patch; returns the settings now in force. */
  update(patch: BotDiskSettingsPatch, actor: BotDiskActor): Promise<BotDiskView>;
}

let botDiskTransitionQueue: Promise<void> = Promise.resolve();

function withBotDiskTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = botDiskTransitionQueue.then(run);
  // A rejected transition must not wedge every later one behind it.
  botDiskTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function botDiskService(
  db: Db,
  overrides: Partial<BotDiskServiceDeps> = {},
): BotDiskService {
  const deps: BotDiskServiceDeps = {
    settings: overrides.settings ?? (instanceSettingsService(db) as unknown as BotDiskServiceDeps["settings"]),
    listCompanyIds: overrides.listCompanyIds ?? (() => instanceSettingsService(db).listCompanyIds()),
    logActivity: overrides.logActivity ?? ((entry) => logActivity(db, entry)),
    env: overrides.env,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (): Promise<BotDiskView> => {
      const general = await deps.settings.getGeneral();
      return resolveBotDiskSettings({ stored: general.botDisk, env });
    },

    update: async (patch, actor) =>
      withBotDiskTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveBotDiskSettings({ stored: general.botDisk, env });
        const next = mergeBotDiskSettings(before.settings, patch);
        const changedKeys: string[] = BOT_DISK_SETTING_KEYS.filter((key) => before.settings[key] !== next[key]);
        // myrmidon(1.6.1-BOT-DISK-B, 1.6.2-BOT-DISK-C): the shared-cache layout
        // keys (cache path, git mirrors, pnpm store) ride the same key.
        for (const key of BOT_DISK_LAYOUT_KEYS) {
          if (JSON.stringify(before.settings[key]) !== JSON.stringify(next[key])) changedKeys.push(key);
        }

        await deps.settings.updateGeneral({ botDisk: next });

        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: BOT_DISK_UPDATED_ACTION,
              entityType: "instance_settings",
              entityId: "bot-disk",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType },
          "bot disk settings updated without a restart",
        );
        return resolveBotDiskSettings({ stored: next, env });
      }),
  };
}

/**
 * The lifecycle config the sweep uses on this tick, from the stored row with
 * the environment as the first-start default. Called on every maintenance
 * tick, so a PATCH takes effect at the next tick without a restart.
 */
export async function resolveBotDiskLifecycleConfig(
  settings: { getGeneral(): Promise<{ botDisk?: unknown }> },
  env: Record<string, string | undefined> = process.env,
): Promise<{ enabled: boolean; idleTtlMs: number; defaultIdleTtlMs: number }> {
  const general = await settings.getGeneral();
  const resolved = resolveBotDiskSettings({ stored: general.botDisk, env });
  const defaults = resolveBotDiskSettings({ env });
  return {
    enabled: resolved.settings.enabled,
    idleTtlMs: resolved.settings.idleTtlMs,
    defaultIdleTtlMs: defaults.settings.idleTtlMs,
  };
}

/**
 * myrmidon(1.6.1-BOT-DISK-B): the shared package cache path stored right now
 * (undefined: no shared cache). The local bot driver (binds) and the profile
 * compiler (the variables pointing the tools at them) call it on every
 * reconcile pass, so a PATCH applies on the next pass without a restart.
 */
export async function readSharedPackageCachePath(db: Db): Promise<string | undefined> {
  const settings = instanceSettingsService(db) as unknown as { getGeneral(): Promise<{ botDisk?: unknown }> };
  return resolveSharedPackageCachePath((await settings.getGeneral()).botDisk);
}

/**
 * myrmidon(1.6.5-BOT-DISK-H11): the shared bot runtime root stored right now
 * (undefined: every bot keeps its own `bin`, `lazy-packages` and `lsp`). The
 * local bot driver (the read-only binds) reads it on every create, recreate and
 * drift check, so a PATCH applies on the next pass without a restart; the
 * operator's own rollout (populate the host directory, then remove the per-bot
 * copies) is described in docs/myrmidon/bot-shared-runtime.md.
 */
export async function readSharedBotRuntimePath(db: Db): Promise<string | undefined> {
  const settings = instanceSettingsService(db) as unknown as { getGeneral(): Promise<{ botDisk?: unknown }> };
  return resolveSharedBotRuntimePath((await settings.getGeneral()).botDisk);
}

/**
 * myrmidon(1.6.2-BOT-DISK-C): the shared-cache layout stored right now (git
 * mirrors, pnpm store mode, with defaults). The local driver (the read-only
 * `/cache/git` bind), the profile compiler (the pnpm store variables) and the
 * mirror refresher read it on every pass, so a PATCH needs no restart.
 */
export async function readBotDiskLayout(db: Db): Promise<BotDiskLayout> {
  const settings = instanceSettingsService(db) as unknown as { getGeneral(): Promise<{ botDisk?: unknown }> };
  const stored = (await settings.getGeneral()).botDisk;
  warnPnpmSettings(stored);
  return resolveBotDiskLayout(stored);
}

/** The pnpm warnings already logged (a layout is read on every tick; each text goes out once per process). */
const loggedPnpmWarnings = new Set<string>();

/**
 * myrmidon(1.6.5-BOT-DISK-H8a): a pnpm value of an earlier release that reads as
 * a different one today, or a store inside the bot's own tree, is logged — once
 * per text — rather than applied or dropped silently.
 */
function warnPnpmSettings(stored: unknown): void {
  for (const warning of botDiskPnpmWarnings(stored)) {
    if (loggedPnpmWarnings.has(warning)) continue;
    loggedPnpmWarnings.add(warning);
    logger.warn({ setting: "general.botDisk" }, warning);
  }
}

/**
 * myrmidon(1.6.2-BOT-DISK-C): the cache path for a bot of `role`, or undefined
 * when the bot is outside the configured roles (`sharedCacheRoles`): such a bot
 * gets no cache mounts and variables, so it is not recreated when the cache is
 * enabled. Read per call, so a role change applies without a restart.
 */
export async function readSharedPackageCachePathForRole(db: Db, role: string | null | undefined): Promise<string | undefined> {
  const layout = await readBotDiskLayout(db);
  if (!layout.sharedPackageCachePath) return undefined;
  return botRoleGetsSharedCache(layout.sharedCacheRoles, role) ? layout.sharedPackageCachePath : undefined;
}

/**
 * myrmidon(1.6.2-BOT-DISK-C): the idle TTL in seconds the in-container clone reaper
 * is told (0 when the lifecycle is off), or undefined for a bot outside the
 * configured roles. Read per profile compile, so a change applies without a restart.
 */
export async function readCloneIdleTtlSecForRole(db: Db, role: string | null | undefined): Promise<number | undefined> {
  const settings = instanceSettingsService(db) as unknown as { getGeneral(): Promise<{ botDisk?: unknown }> };
  const general = await settings.getGeneral();
  const layout = resolveBotDiskLayout(general.botDisk);
  if (!botRoleGetsSharedCache(layout.sharedCacheRoles, role)) return undefined;
  const config = await resolveBotDiskLifecycleConfig({ getGeneral: async () => general });
  return config.enabled ? Math.max(1, Math.round(config.idleTtlMs / 1000)) : 0;
}

/** Same for the driver, which knows the bot key (= agent id) and not the role. */
export async function readBotCacheLayoutForBot(
  db: Db,
  botKey: string,
): Promise<{ path?: string; gitMirror: boolean }> {
  const layout = await readBotDiskLayout(db);
  if (!layout.sharedPackageCachePath) return { gitMirror: false };
  const rows = await db.select({ role: agents.role }).from(agents).where(eq(agents.id, botKey)).limit(1);
  if (!botRoleGetsSharedCache(layout.sharedCacheRoles, rows[0]?.role)) return { gitMirror: false };
  return { path: layout.sharedPackageCachePath, gitMirror: layout.gitMirrorRepos.length > 0 };
}

/**
 * One sweep with the settings stored right now — what the maintenance tick
 * calls. Async throughout, so a failed settings read rejects (the caller logs
 * it) instead of throwing inside the timer.
 *
 * myrmidon(1.6.2-BOT-DISK-C): the same tick refreshed the git mirrors (each at
 * most once per `gitMirrorRefreshMs`, one refresh at a time) and judged git
 * clones by the bots' own hygiene reports (draft-lifecycle.ts).
 *
 * myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the report COLLECTION moved off this
 * tick onto its own timer (`startCloneReportCollection`): the maintenance tick
 * is 5 s by design (window transitions), and collecting 74 bots' reports on it
 * meant ~30 dockergate requests per second — the A2/A3 storm. The lifecycle
 * sweep itself (disk work on the host, no gate calls) stays on the tick.
 */
export async function runBotDiskSweep(db: Db): Promise<void> {
  const settings = instanceSettingsService(db) as unknown as {
    getGeneral(): Promise<{ botDisk?: unknown }>;
  };
  const general = await settings.getGeneral();
  const layout = resolveBotDiskLayout(general.botDisk);
  void refreshGitMirrors(layout).catch((err) => logger.warn({ err }, "git mirror refresh failed"));
  const lifecycle = await resolveBotDiskLifecycleConfig({ getGeneral: async () => general });
  await sweepAllBotVolumes(lifecycle);
}

/**
 * myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the clone-hygiene collector on its own
 * interval (readCloneReportIntervalMs, default 300 s), each bot read under the
 * process-wide per-bot lock so the pass and a reconcile never run side by side
 * on one bot. Started by startBotContainers when the container runtime is on;
 * a runtime that was never built (the flag is off) collects nothing — the
 * reports live in containers this board does not manage. Returns the stop
 * function; never throws.
 */
export function startCloneReportCollection(
  db: Db,
  opts: { intervalMs?: number; env?: NodeJS.ProcessEnv; lock?: BotKeyLock } = {},
): () => void {
  const env = opts.env ?? process.env;
  const intervalMs = opts.intervalMs ?? readCloneReportIntervalMs(env);
  const lock = opts.lock ?? botKeyLock;
  let inFlight: Promise<void> | null = null;
  const pass = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const general = await instanceSettingsService(db).getGeneral();
      const lifecycle = await resolveBotDiskLifecycleConfig({ getGeneral: async () => general });
      await collectCloneReports(lifecycle.idleTtlMs, () => readContainerBotKeys(db), undefined, (botKey, fn) => lock.run(botKey, fn));
    })()
      .catch((err) => logger.warn({ err }, "clone hygiene report collection failed"))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref?.();
  void pass();
  return () => {
    clearInterval(timer);
  };
}

/**
 * myrmidon(OPE-4789): how often `collectCloneReports` may poll the containers.
 * It runs from the maintenance tick (default 5 s), and each poll is a per-bot
 * inspect + archive read against dockergate — on a 74-bot fleet that alone was
 * ~59 requests/s of the ~30/s storm of OPE-4752. The reports feed attention
 * signals about unpushed work idle past the lifecycle TTL (default an hour);
 * a 60 s cadence loses nothing an operator can notice, at 1/12 of the load.
 * The collection runs at most once per this interval, whichever tick asks.
 */
export const CLONE_REPORT_COLLECT_INTERVAL_MS = 60_000;

/**
 * myrmidon(1.6.4-BOT-CONTAINER-CARD): the bots the board manages a container for,
 * from the agent cards (an enabled, complete hermes_gateway container block).
 * The container runtime is never listed: dockergate has no such call.
 */
export async function readContainerBotKeys(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.adapterType, "hermes_gateway"));
  const keys: string[] = [];
  for (const row of rows) {
    if (!readBotContainerAgentConfig(row.adapterType, row.adapterConfig ?? {}).ok) continue;
    const key = botKeyForAgent(row.id);
    if (key) keys.push(key);
  }
  return keys;
}

// myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the clone-hygiene reports ride their
// OWN timer, not the maintenance tick. Until here `runBotDiskSweep` ran on the
// maintenance interval (MYRMIDON_MAINTENANCE_TICK_SEC, default 5 s) and each
// pass asked for every bot (inspect + report read): 74 bots x 2 = ~30 gate
// requests per second — 05.10's A2/A3 storm, which drained the gate's global
// bucket and stalled fleet rollouts on 429. A report is valid for 24 h
// (CLONE_HYGIENE_REPORT_MAX_AGE_MS) and the idle TTL it feeds is in hours: the
// 5 s cadence bought nothing. The collector now runs at its own interval
// (MYRMIDON_CLONE_REPORT_INTERVAL_SEC, default 300 s) and takes the per-bot
// lock around each read, so a report read never interleaves a reconcile or a
// rollout of the same bot.
const CLONE_REPORT_INTERVAL_ENV = "MYRMIDON_CLONE_REPORT_INTERVAL_SEC";
const DEFAULT_CLONE_REPORT_INTERVAL_SEC = 300;
const MIN_CLONE_REPORT_INTERVAL_SEC = 60;
const MAX_CLONE_REPORT_INTERVAL_SEC = 86_400;

/** The collector period; an unset, non-integer or out-of-range value falls back
 *  to the default (the same rule as the reconcile interval, startup.ts). */
export function readCloneReportIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CLONE_REPORT_INTERVAL_ENV]?.trim();
  if (!raw) return DEFAULT_CLONE_REPORT_INTERVAL_SEC * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_CLONE_REPORT_INTERVAL_SEC || value > MAX_CLONE_REPORT_INTERVAL_SEC) {
    return DEFAULT_CLONE_REPORT_INTERVAL_SEC * 1000;
  }
  return value * 1000;
}

/**
 * myrmidon(1.6.2-BOT-DISK-C): read each running bot's clone-hygiene report from
 * its container (the board has no mount of the volumes) and turn unpushed work
 * idle past the TTL into attention signals. A bot without a report is skipped.
 *
 * myrmidon(1.6.4-BOT-CONTAINER-CARD): the bots come from the agent cards
 * (`readBotKeys`) and each is asked by its own name (inspect, then the report
 * read) — calls dockergate allows. The earlier container listing was refused
 * (403 route_not_allowed) on every sweep, so no report was ever collected.
 *
 * myrmidon(OPE-4789): `minIntervalMs` throttles the collection — it rides the
 * 5 s maintenance tick, and a per-bot poll at that pace was the A2/A3 storm
 * (OPE-4752). Within the interval the call returns without touching the
 * runtime (the in-memory signals simply stay as they are; a skipped pass drops
 * nothing — a removed bot's signals age out on the next real pass). A driver
 * with `listRunning` is asked for running bots only, so a stopped bot's
 * inspect is not paid for a report it cannot serve.
 *
 * myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): each bot is read under the same
 * per-bot lock the reconcile sweep holds (`withBotKey`), so a collection pass
 * and a rollout of one bot cannot interleave their gate calls (the task's
 * mutual-exclusion requirement). Without the port (tests, a runtime with a
 * custom lock) the reads run unlocked, as before.
 */
let lastCloneReportCollectionAtMs: number | null = null;

/** Test hook: lets a test run two collections back to back. */
export function resetCloneReportCollectionClockForTests(): void {
  lastCloneReportCollectionAtMs = null;
}

export async function collectCloneReports(
  idleTtlMs: number,
  readBotKeys: () => Promise<string[]>,
  minIntervalMs?: number,
  withBotKey?: (botKey: string, fn: () => Promise<void>) => Promise<void>,
): Promise<void> {
  if (minIntervalMs !== undefined && lastCloneReportCollectionAtMs !== null && Date.now() - lastCloneReportCollectionAtMs < minIntervalMs) {
    return;
  }
  const driver = getBotContainerRuntime()?.driver;
  if (!driver?.readCloneReport) return;
  const botKeys = await readBotKeys();
  const bots = driver.listRunning ? await driver.listRunning(botKeys) : (await driver.list(botKeys)).filter((bot) => bot.state === "running");
  lastCloneReportCollectionAtMs = Date.now();
  const live = new Set<string>();
  for (const bot of bots) {
    const read = async () => {
      try {
        const raw = await driver.readCloneReport!(bot.botKey);
        if (raw === null) return;
        if (ingestCloneReport(bot.botKey, raw, idleTtlMs)) {
          live.add(bot.botKey);
          noteCloneReportSeen();
        }
      } catch (err) {
        logger.warn({ err, botKey: bot.botKey }, "clone hygiene report read failed");
      }
    };
    if (withBotKey) await withBotKey(bot.botKey, read);
    else await read();
  }
  dropCloneSignalsExcept(live);
}
