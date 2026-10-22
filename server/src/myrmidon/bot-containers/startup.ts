// server/src/myrmidon/bot-containers/startup.ts
//
// myrmidon(W2a): startup wiring of the bot container reconciler. server/src/index.ts
// has one marked call, `startBotContainers(db)`, next to startMaintenanceMode, and
// one at shutdown, `stopBotContainers()`; everything else lives here.
//
// With MYRMIDON_BOT_CONTAINERS off (the default) `startBotContainers` returns
// before it creates or reads anything: no Docker driver, no query, no timer, no
// registered runtime. With it on it builds the runtime once
//  - the Docker driver (G3) over the socket `MYRMIDON_BOT_DOCKER_SOCKET`
//    (default /var/run/docker.sock), volumes and network from the G3 settings;
//  - the profile compiler and the card sync (W2a, profile-ports.ts);
//  - the maintenance port (R3);
// then starts the periodic sweep (`MYRMIDON_BOT_RECONCILE_INTERVAL_SEC`, default
// 60) over the agents `listBotContainerAgents` returns, and registers the same
// runtime for the card's "Apply now" (W2b, routes-wiring.ts), which answers 503
// until a runtime is registered.
//
// A runtime that cannot be built (for example MYRMIDON_BOT_VOLUME_ROOT unset)
// is logged as an error and nothing is started or registered: the board keeps
// serving, the containers stay as they are, and the card reports the runtime as
// not configured. That is deliberate: a bot-container settings mistake must not
// stop the whole board.

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/instance-settings.js"; // myrmidon(1.6.1-BOT-DISK-D)
import { listBotContainerAgents } from "./agents-query.js";
import { isBotContainersEnabled } from "./agent-config.js";
import type { BotContainerDriver } from "./driver.js";
import { dockerBotContainerDriver, readDockerDriverConfig, type DockerDriverConfig } from "./docker-driver.js";
import { fleetRoutingDriver } from "./fleetd-routing.js";
import { bootstrapFleetSitesFromEnv, createFleetClientManager, type FleetClientManager } from "./site-registry.js";
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  realBotMaintenancePort,
  startBotContainerReconciliation,
  type BotContainerAgent,
  type BotContainerRuntimeDeps,
} from "./index.js";
import { botProfileWiring } from "./profile-ports.js";
import type { BotContainerActivitySink, BotMaintenancePort } from "./reconciler.js";
import { botContainerAgentReader, getBotContainerRuntime, setBotContainerRuntime } from "./routes-wiring.js";
import { readBotCacheLayoutForBot, readSharedBotRuntimePath, startCloneReportCollection } from "./bot-disk-service.js"; // myrmidon(1.6.1-BOT-DISK-B, 1.6.2-BOT-DISK-C, 1.6.5-BOT-DISK-H11, 1.6.5-DOCKERGATE-A2A3-STORM)
import { scopeMigrator } from "./scope-migration.js"; // myrmidon(BOT-DISK-F)
import { readAppliedScopeLayout } from "./scope-wiring.js"; // myrmidon(BOT-DISK-F)

export const BOT_RECONCILE_INTERVAL_ENV = "MYRMIDON_BOT_RECONCILE_INTERVAL_SEC";
const MIN_RECONCILE_INTERVAL_SEC = 5;
const MAX_RECONCILE_INTERVAL_SEC = 3600;

/** The sweep period. An unset, non-integer or out-of-range value falls back to the
 *  default (the same rule as the maintenance settings, R3). */
export function readBotReconcileIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BOT_RECONCILE_INTERVAL_ENV]?.trim();
  if (!raw) return DEFAULT_RECONCILE_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_RECONCILE_INTERVAL_SEC || value > MAX_RECONCILE_INTERVAL_SEC) {
    return DEFAULT_RECONCILE_INTERVAL_MS;
  }
  return value * 1000;
}

/** The two server-log calls this module makes (the pino logger satisfies it). */
export interface BotContainersLog {
  info(fields: object, message: string): void;
  /** Optional: a log without it gets warnings at `info`. */
  warn?(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** Reconciler events go to the server log: an error at `error`, the rest at `info`. */
export function createBotContainerLogSink(log: BotContainersLog = logger): BotContainerActivitySink {
  return {
    record(entry) {
      const fields = { agentId: entry.agentId, botKey: entry.botKey, ...(entry.details ? { details: entry.details } : {}) };
      if (entry.level === "error") log.error(fields, `bot containers: ${entry.message}`);
      else log.info(fields, `bot containers: ${entry.message}`);
    },
  };
}

/** What `startBotContainers` builds its runtime from; tests replace these. */
export interface BotContainersStartupPorts {
  readDriverConfig(env: NodeJS.ProcessEnv): DockerDriverConfig;
  /** `db` feeds the instance settings the driver reads per pass (the shared
   *  package cache path, 1.6.1-BOT-DISK-B). */
  createDriver(config: DockerDriverConfig, db: Db): BotContainerDriver;
  profileWiring(
    db: Db,
    opts: { activity: BotContainerActivitySink; env: NodeJS.ProcessEnv },
  ): Pick<
    BotContainerRuntimeDeps,
    | "compile"
    | "beginProfilePass"
    | "endProfilePass"
    | "syncCard"
    | "releaseStrayGateways"
    | "exportMediaAcl"
  >;
  maintenancePort(db: Db): BotMaintenancePort;
  listAgents(db: Db): () => Promise<BotContainerAgent[]>;
  /** One agent's card at the moment of a pass (index.ts `readAgent`): the sweep
   *  lists the table once per tick, so each pass re-reads its own row instead of
   *  reconciling the tick's snapshot. */
  readAgent(db: Db): (agentId: string) => Promise<BotContainerAgent | null>;
  activitySink(): BotContainerActivitySink;
  registerRuntime(runtime: BotContainerRuntimeDeps | null): void;
  currentRuntime(): BotContainerRuntimeDeps | null;
  startReconciliation: typeof startBotContainerReconciliation;
  /**
   * myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the clone-hygiene collector's own
   * timer (bot-disk-service.startCloneReportCollection). Optional: a test that
   * fakes the ports without it starts no collector; the real startup wires the
   * real one. Its stop is folded into the stop of this run.
   */
  startCloneReportCollection?: typeof startCloneReportCollection;
  /**
   * myrmidon(1.6.6 T3): the remote-site clients (registry sites by company and name)
   * and the one-time import of MYRMIDON_FLEET_HOSTS into the registry. Optional so
   * a test without a registry builds the runtime without a database round trip.
   */
  createFleetClientManager?: typeof createFleetClientManager;
  bootstrapFleetSitesFromEnv?: typeof bootstrapFleetSitesFromEnv;
  log: BotContainersLog;
}

const defaultPorts: BotContainersStartupPorts = {
  readDriverConfig: (env) => readDockerDriverConfig(env),
  createDriver: (config, db) =>
    dockerBotContainerDriver(config, {
      // myrmidon(BOT-DISK-F): the layout the owner applied (isolated unless a scope change was applied),
      // and the host-side move of a bot's directories when a recreate changes it.
      readScopeLayout: (botKey) => readAppliedScopeLayout(db, botKey),
      scopeMigration: scopeMigrator({ volumeRoot: config.volumeRoot, scopeRoot: config.scopeRoot ?? `${config.volumeRoot}/.scopes` }),
      // myrmidon(1.6.2-BOT-DISK-C): only bots of the configured roles get cache mounts.
      readSharedPackageCachePath: async (botKey) => (await readBotCacheLayoutForBot(db, botKey)).path,
      readGitMirrorEnabled: async (botKey) => (await readBotCacheLayoutForBot(db, botKey)).gitMirror,
      // myrmidon(1.6.5-BOT-DISK-H11): the shared bot runtime is the same for
      // every bot of the instance, so it is not role-gated; the driver adds the
      // three read-only binds only when the operator has set the path.
      readSharedBotRuntimePath: async () => readSharedBotRuntimePath(db),
    }),
  profileWiring: (db, opts) => botProfileWiring(db, opts),
  maintenancePort: (db) => realBotMaintenancePort(db),
  listAgents: (db) => listBotContainerAgents(db),
  readAgent: (db) => botContainerAgentReader(db),
  activitySink: () => createBotContainerLogSink(),
  registerRuntime: setBotContainerRuntime,
  currentRuntime: getBotContainerRuntime,
  startReconciliation: startBotContainerReconciliation,
  startCloneReportCollection,
  log: logger,
};

let stopRunning: (() => void) | null = null;

/**
 * Builds the runtime and starts the periodic sweep, once; see the module comment.
 * Returns the stop function (also reachable through `stopBotContainers`). Never
 * throws: a runtime that cannot be built is logged and nothing is started. A
 * repeated call replaces the previous run.
 */
export function startBotContainers(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<BotContainersStartupPorts> } = {},
): () => void {
  const env = opts.env ?? process.env;
  if (!isBotContainersEnabled(env)) return () => {};
  const ports: BotContainersStartupPorts = { ...defaultPorts, ...opts.ports };
  stopBotContainers();

  const intervalMs = readBotReconcileIntervalMs(env);
  const started = build(db, env, intervalMs, ports);
  if (!started) return () => {};
  const { runtime, stopSweep } = started;
  ports.registerRuntime(runtime);
  ports.log.info({ intervalMs, network: runtime.network }, "bot container reconciliation started");
  // myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the collector needs a registered
  // runtime (it reads the reports through its driver), so it starts after the
  // registration and stops with this run.
  const stopCollector = ports.startCloneReportCollection?.(db, { env }) ?? null;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopSweep();
    stopCollector?.();
    // Only clear the registry entry this run put there.
    if (ports.currentRuntime() === runtime) ports.registerRuntime(null);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Builds the runtime and starts the sweep over it; null (after logging) when that fails. */
function build(
  db: Db,
  env: NodeJS.ProcessEnv,
  intervalMs: number,
  ports: BotContainersStartupPorts,
): { runtime: BotContainerRuntimeDeps; stopSweep: () => void } | null {
  let clientManager: FleetClientManager | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const driverConfig = ports.readDriverConfig(env);
    const activity = ports.activitySink();
    const { compile, beginProfilePass, endProfilePass, syncCard, releaseStrayGateways, exportMediaAcl } =
      ports.profileWiring(db, { activity, env });

    // myrmidon(1.6.6 T3): every driver call is routed by the bot's card
    // (container.site, or the legacy container.host): no placement is the local
    // docker driver, a named site/host is that site's fleetd client.
    const localDriver = ports.createDriver(driverConfig, db);
    const warn = ports.log.warn ?? ports.log.info;
    const fleetLog = {
      info: (fields: object, message: string) => ports.log.info(fields, message),
      warn: (fields: object, message: string) => warn.call(ports.log, fields, message),
      error: (fields: object, message: string) => ports.log.error(fields, message),
    };
    const manager = (ports.createFleetClientManager ?? createFleetClientManager)({ db, log: fleetLog });
    clientManager = manager;
    const bootstrap = ports.bootstrapFleetSitesFromEnv ?? bootstrapFleetSitesFromEnv;
    // Every routed call waits for this first load, so a pass that starts at once
    // does not meet an empty registry; a failure is logged and the load goes on.
    const ready: Promise<void> = (async () => {
      try {
        await bootstrap(db, env, fleetLog);
      } catch (err) {
        ports.log.error({ err }, "failed to bootstrap fleet sites from MYRMIDON_FLEET_HOSTS");
      }
      try {
        await manager.refresh();
      } catch (err) {
        ports.log.error({ err }, "failed to refresh fleet clients from registry");
      }
    })();
    // A site added, changed or switched off in the registry is picked up within one
    // sweep period, no board restart. The refresh only rebuilds a client whose
    // URL, token secret or CA changed.
    refreshTimer = setInterval(() => {
      manager.refresh().catch((err) => {
        ports.log.error({ err }, "failed to refresh fleet clients from registry");
      });
    }, intervalMs);
    refreshTimer.unref?.();

    const readAgentFn = ports.readAgent(db);
    const unsupportedLogged = new Set<string>();
    const routingDriver = fleetRoutingDriver(
      {
        local: localDriver,
        fleet: (companyId) => manager.getClients(companyId),
        ready,
        onRemoteUnsupported: (method) => {
          if (unsupportedLogged.has(method)) return;
          unsupportedLogged.add(method);
          ports.log.info(
            { method },
            "bot containers: the driver of a remote site does not offer this method; its bots are skipped by it (v1: no skills back-import or clone report on remote sites)",
          );
        },
      },
      // Fail-closed: a card that cannot be read throws, it never falls back to the
      // local driver (that would start a second copy of a remote bot on this host).
      async (botKey: string) => {
        const agent = await readAgentFn(botKey);
        if (!agent) return undefined;
        return {
          adapterConfig: agent.adapterConfig as { container?: unknown },
          ...(agent.companyId ? { companyId: agent.companyId } : {}),
        };
      },
    );

    const runtime: BotContainerRuntimeDeps = {
      driver: routingDriver,
      compile,
      // myrmidon(PERF-DIET-G): the sweep shares one pass between the bots it
      // reconciles (index.ts); the wiring supplies the pair beside compile.
      ...(beginProfilePass ? { beginProfilePass } : {}),
      ...(endProfilePass ? { endProfilePass } : {}),
      syncCard,
      ...(releaseStrayGateways ? { releaseStrayGateways } : {}),
      // myrmidon(MEDIA-PROVISION): per-tick media ACL registry export (index.ts sweep hook).
      ...(exportMediaAcl ? { exportMediaAcl } : {}),
      maintenance: ports.maintenancePort(db),
      activity,
      readAgent: ports.readAgent(db),
      network: driverConfig.network,
      // myrmidon(1.6.1-BOT-DISK-D): live `general.sharedMount`, read on every pass.
      readSharedMountSettings: async () => (await instanceSettingsService(db).getGeneral()).sharedMount,
      // myrmidon(BOT-ROLLOUT): deferred-rollout records (deferred-store.ts)
      // and the watcher's backstop audit.
      db,
      rolloutAudit: (entry) =>
        logActivity(db, {
          companyId: entry.companyId,
          actorType: "system",
          actorId: "myrmidon-bot-containers",
          agentId: entry.agentId,
          action: entry.action,
          entityType: "myrmidon_bot_rollout",
          entityId: entry.entityId,
          details: entry.details,
        }).then(() => undefined),
      rolloutCompanyIdOf: async (agentId) => {
        const row = await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0] ?? null);
        return row?.companyId ?? null;
      },
      // myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401): the company lookup the
      // back-import's catalog ports are built from (skill-backimport-ports.ts).
      // The flag itself (MYRMIDON_BOT_SKILL_BACKIMPORT, off by default) is
      // read inside the reconciler.
      backimportCompanyIdOf: async (agentId) => {
        const row = await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0] ?? null);
        return row?.companyId ?? null;
      },
    };
    const stopReconciliation = ports.startReconciliation(ports.listAgents(db), runtime, { intervalMs, env });
    const stopSweep = () => {
      stopReconciliation();
      clearInterval(refreshTimer);
      manager.close();
    };
    return { runtime, stopSweep };
  } catch (err) {
    if (refreshTimer) clearInterval(refreshTimer);
    clientManager?.close();
    ports.log.error({ err }, "bot containers are enabled but the runtime could not be built; reconciliation is not started");
    return null;
  }
}

/** Stops the sweep started by `startBotContainers` (server shutdown); a no-op when none is running. */
export function stopBotContainers(): void {
  stopRunning?.();
}
