import { BotContainerDriver, BotContainerStatus } from './bot-containers/driver.js';
import { Db, heartbeatRuns, agents, botApplyJobs } from '@myrmidon/db';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import { readMaintenanceDocument } from './maintenance/store.js';
import { idleStopRuntimeFromStatus, type IdleStopRuntime } from './idle-stop-runtime.js';
import { instanceSettingsService } from '../services/instance-settings.js';

// Logger type - matches pino Logger interface
export interface IdleStopLogger {
  info: (msg: string, ...args: any[]) => void;
  warn: (msg: string, ...args: any[]) => void;
  error: (msg: string, ...args: any[]) => void;
  debug: (msg: string, ...args: any[]) => void;
}

export interface IdleStopConfig {
  enabled: boolean;
  afterSec: number;
  healthTimeoutMs: number;
  sweepIntervalMs: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const ACTIVE_RUN_STATUSES = ['running', 'queued', 'scheduled_retry'] as const;

/**
 * IDLE-STOP service: stops idle bot containers and wakes them up on demand.
 *
 * A container is idle when it has no active heartbeat runs for longer than
 * `MYRMIDON_IDLE_STOP_AFTER_SEC`. The sweeper periodically checks all bot
 * containers and stops those that are idle.
 *
 * Wake: when a run is about to start for a stopped container, `wake()` starts
 * the container and waits for it to become healthy (with timeout).
 */
export class IdleStopService {
  private readonly config: IdleStopConfig;
  private readonly driver: BotContainerDriver;
  private readonly db: Db;
  private readonly logger: IdleStopLogger;
  private sweepInterval?: NodeJS.Timeout;
  private startupTimes: Map<string, number> = new Map();
  private configCache?: { value: IdleStopConfig; expiresAt: number };

  constructor(driver: BotContainerDriver, db: Db, config: Partial<IdleStopConfig> = {}, loggerInstance?: IdleStopLogger) {
    this.driver = driver;
    this.db = db;
    // Use provided logger or create a simple console-based fallback
    this.logger = loggerInstance ?? {
      info: (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args),
      warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
      error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
      debug: (msg: string, ...args: any[]) => console.debug(`[DEBUG] ${msg}`, ...args),
    };
    this.config = {
      enabled: config.enabled ?? true,
      afterSec: config.afterSec ?? 1800, // 30 minutes default
      healthTimeoutMs: config.healthTimeoutMs ?? 30000,
      sweepIntervalMs: config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    };
  }

  public start(): void {
    // The sweeper always runs: the live `enabled` flag (board settings) is read on every
    // sweep, so switching IDLE-STOP on from the board needs no restart.
    if (!this.config.enabled) {
      this.logger.info('IDLE-STOP is disabled at startup; the sweeper stays idle until it is enabled in settings');
    }

    this.logger.info(
      `Starting IDLE-STOP service: afterSec=${this.config.afterSec}, healthTimeoutMs=${this.config.healthTimeoutMs}`,
    );

    this.sweepInterval = setInterval(() => {
      void this.performSweep();
    }, this.config.sweepIntervalMs);

    // Initial sweep after 5 seconds
    setTimeout(() => {
      void this.performSweep();
    }, 5_000);
  }

  public stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = undefined;
    }
  }

  /**
   * Performs a sweep: stops idle containers that have no active runs.
   * A container is idle when its agent has no heartbeat runs in active statuses
   * and the last run finished longer than `afterSec` ago.
   */
  public async performSweep(): Promise<void> {
    const config = await this.currentConfig();
    if (!config.enabled) {
      return;
    }

    try {
      this.logger.debug('Starting idle container sweep');

      const { botKeys, alwaysOn } = await this.listBots();
      if (botKeys.length === 0) {
        this.logger.debug('No bot container agents found, skipping sweep');
        return;
      }

      const containers = await this.driver.list(botKeys);
      this.logger.debug(`Found ${containers.length} bot containers`);

      for (const container of containers) {
        await this.checkContainer(container, config.afterSec, alwaysOn.has(container.botKey));
      }
    } catch (error) {
      this.logger.error('Error during idle container sweep:', error);
    }
  }

  /**
   * Lists the bot keys of all container-enabled hermes_gateway agents.
   * The driver cannot list containers itself (dockergate allowlist), so the
   * board names the bots — from the agents table, same as the reconciliation
   * sweep.
   */
  /**
   * True when the agent is a container-enabled hermes_gateway agent (the predicate of listBotKeys).
   * On a database error the answer is true, which keeps the strict "container is missing" check.
   */
  private async isContainerBot(botKey: string): Promise<boolean> {
    try {
      const rows = await this.db
        .select({ agentId: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, botKey),
            eq(agents.adapterType, 'hermes_gateway'),
            sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
          ),
        );
      return rows.length > 0;
    } catch (error) {
      this.logger.error(`Error checking whether bot ${botKey} has a container:`, error);
      return true;
    }
  }

  private async listBots(): Promise<{ botKeys: string[]; alwaysOn: Set<string> }> {
    try {
      const rows = await this.db
        .select({ agentId: agents.id, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(
          and(
            eq(agents.adapterType, 'hermes_gateway'),
            sql`${agents.status} != 'terminated'`,
            sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
          ),
        );
      const alwaysOn = new Set<string>();
      for (const row of rows) {
        const container = (row.adapterConfig as { container?: { idleStopMode?: unknown } } | null | undefined)?.container;
        if (container?.idleStopMode === 'always_on') alwaysOn.add(row.agentId);
      }
      return { botKeys: rows.map((row) => row.agentId), alwaysOn };
    } catch (error) {
      this.logger.error('Error listing bot container agents:', error);
      return { botKeys: [], alwaysOn: new Set() };
    }
  }

  private async checkContainer(container: BotContainerStatus, afterSec: number, alwaysOn: boolean): Promise<void> {
    const botKey = container.botKey;

    // Per-bot mode "always on": never stopped, whatever the idle time.
    if (alwaysOn) {
      this.logger.debug(`Bot ${botKey} is configured always-on, skipping stop`);
      return;
    }

    // Only stop running containers
    if (container.state !== 'running') {
      this.logger.debug(`Bot ${botKey} is not running (state=${container.state}), skipping`);
      return;
    }

    if (await this.isApplyOrMaintenanceActive(botKey, container, afterSec)) {
      this.logger.debug(`Bot ${botKey} is undergoing apply/recreate or maintenance, skipping`);
      return;
    }

    const hasActiveRuns = await this.hasActiveRuns(botKey);
    if (hasActiveRuns) {
      this.logger.debug(`Bot ${botKey} has active runs, skipping`);
      return;
    }

    const idleDurationSec = await this.getIdleDurationSec(botKey, container);
    if (idleDurationSec < afterSec) {
      this.logger.debug(
        `Bot ${botKey} is idle but not long enough (${idleDurationSec}s/${afterSec}s)`,
      );
      return;
    }

    this.logger.info(`Stopping idle container for bot ${botKey} (idle for ${idleDurationSec}s)`);
    try {
      if (!this.driver.stopIdle) throw new Error('idle-stop route is not supported by this driver');
      await this.driver.stopIdle(botKey);
    } catch (error) {
      this.logger.error(`Failed to stop container for bot ${botKey} [${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  public invalidateConfigCache(): void {
    this.configCache = undefined;
  }

  /**
   * Container state with the last stop/start times (from the container's docker inspect, so
   * they survive a board restart).
   */
  public async readRuntimeState(botKey: string): Promise<{ state: string } & IdleStopRuntime> {
    const status = await this.driver.status(botKey);
    return { state: status.state, ...idleStopRuntimeFromStatus(status) };
  }

  /** Effective settings: stored board settings over startup (env) values; re-read every 2 s at most. */
  private async currentConfig(): Promise<IdleStopConfig> {
    try {
      if (this.configCache && this.configCache.expiresAt > Date.now()) return this.configCache.value;
      const settings = instanceSettingsService(this.db) as unknown as { getGeneral(): Promise<{ idleStop?: unknown }> };
      const raw = (await settings.getGeneral()).idleStop;
      if (raw && typeof raw === 'object') {
        const value = raw as Record<string, unknown>;
        const resolved: IdleStopConfig = {
          ...this.config,
          enabled: typeof value.enabled === 'boolean' ? value.enabled : this.config.enabled,
          afterSec: typeof value.afterSec === 'number' && Number.isFinite(value.afterSec) ? value.afterSec : this.config.afterSec,
          healthTimeoutMs: typeof value.healthTimeoutMs === 'number' && Number.isFinite(value.healthTimeoutMs) ? value.healthTimeoutMs : this.config.healthTimeoutMs,
        };
        this.configCache = { value: resolved, expiresAt: Date.now() + 2_000 };
        return resolved;
      }
    } catch (error) {
      this.logger.error(`Could not read live IDLE-STOP settings; keeping startup config [${error instanceof Error ? error.message : String(error)}]`);
    }
    return this.config;
  }

  private async isApplyOrMaintenanceActive(botKey: string, container: BotContainerStatus, afterSec: number): Promise<boolean> {
    const inspect = container.inspect as
      | { State?: { Health?: { Status?: string }; StartedAt?: string } }
      | undefined;
    if (inspect?.State?.Health?.Status === 'starting') {
      return true;
    }
    if (inspect?.State?.StartedAt) {
      const startedAtMs = new Date(inspect.State.StartedAt).getTime();
      if (Number.isFinite(startedAtMs) && (Date.now() - startedAtMs) < afterSec * 1000) {
        return true;
      }
    }

    let agentId: string | null = null;
    try {
      agentId = await this.resolveAgentId(botKey);
      if (agentId) {
        const [activeApply] = await this.db
          .select({ id: botApplyJobs.id })
          .from(botApplyJobs)
          .where(
            and(
              eq(botApplyJobs.botId, agentId),
              inArray(botApplyJobs.status, ['pending', 'running']),
            ),
          )
          .limit(1);
        if (activeApply) return true;
      }
    } catch {
      // In tests with fakeDb or if table not configured in mock
    }

    try {
      const doc = await readMaintenanceDocument(this.db);
      const isMaintenance = doc.windows.some(
        (w) =>
          (w.state === 'entering' || w.state === 'on' || w.state === 'leaving') &&
          (w.scope.type === 'instance' ||
            (w.scope.type === 'agent' && (w.scope.id === botKey || (agentId && w.scope.id === agentId)))),
      );
      if (isMaintenance) return true;
    } catch {
      // ignore
    }

    return false;
  }

  /**
   * Checks if a bot has any active heartbeat runs.
   * Active statuses: running, queued, scheduled_retry.
   */
  private async hasActiveRuns(botKey: string): Promise<boolean> {
    try {
      // botKey is the agentId (UUID or string key)
      const agentId = await this.resolveAgentId(botKey);
      if (!agentId) {
        this.logger.debug(`No agent found for bot ${botKey}, assuming no active runs`);
        return false;
      }

      const [activeRun] = await this.db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .limit(1);

      return activeRun !== undefined;
    } catch (error) {
      this.logger.error(`Error checking active runs for bot ${botKey}:`, error);
      // Err on the side of caution: if we can't check, assume active runs exist
      return true;
    }
  }

  /**
   * Gets the idle duration in seconds for a bot.
   * Idle = time since the last heartbeat run finished (or started, if none finished).
   */
  private async getIdleDurationSec(botKey: string, container?: BotContainerStatus): Promise<number> {
    try {
      const agentId = await this.resolveAgentId(botKey);
      if (!agentId) {
        return 0;
      }

      // Find the most recent run for this agent
      const [lastRun] = await this.db
        .select({
          finishedAt: heartbeatRuns.finishedAt,
          startedAt: heartbeatRuns.startedAt,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);

      if (!lastRun) {
        // No runs ever - consider it idle since container start
        // We can't know container start time without inspect, so return a large value
        // to avoid stopping newly created containers
        return 0;
      }

      const lastActivity = lastRun.finishedAt ?? lastRun.startedAt;
      if (!lastActivity) {
        return 0;
      }

      let idleMs = Date.now() - new Date(lastActivity).getTime();
      const inspect = container?.inspect as
        | { State?: { StartedAt?: string } }
        | undefined;
      if (inspect?.State?.StartedAt) {
        const startedAtMs = new Date(inspect.State.StartedAt).getTime();
        if (Number.isFinite(startedAtMs)) {
          const uptimeMs = Date.now() - startedAtMs;
          if (uptimeMs >= 0 && uptimeMs < idleMs) {
            idleMs = uptimeMs;
          }
        }
      }
      return Math.floor(idleMs / 1000);
    } catch (error) {
      this.logger.error(`Error getting idle duration for bot ${botKey}:`, error);
      return 0;
    }
  }

  /**
   * Resolves botKey to agentId.
   * botKey is typically the agentId itself (UUID) or a derived key.
   */
  private async resolveAgentId(botKey: string): Promise<string | null> {
    // Check if botKey is already a valid UUID (agentId)
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_PATTERN.test(botKey)) {
      // Verify the agent exists
      const [agent] = await this.db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, botKey))
        .limit(1);
      return agent?.id ?? null;
    }

    // For non-UUID botKeys, we can't map to an agentId
    // This shouldn't happen in practice since botKeyForAgent returns agentId
    this.logger.warn(`Cannot resolve non-UUID botKey ${botKey} to agentId`);
    return null;
  }

  /**
   * Wakes up a bot container if it's stopped, waits for it to be healthy.
   * Returns true if the container is running and healthy, false otherwise.
   * When IDLE-STOP is disabled, returns true immediately without calling the driver.
   */
  public async wake(botKey: string): Promise<boolean> {
    const config = await this.currentConfig();

    try {
      const status = await this.driver.status(botKey);

      // IDLE-STOP switched off: a no-op passthrough — except for a container it stopped earlier,
      // which must still come back (the switch is live, bots may be stopped at that moment).
      if (!config.enabled && !(status.idleStopped && status.state !== 'running')) return true;

      if (status.state === 'running') {
        this.logger.debug(`Bot ${botKey} is already running`);
        return true;
      }

      if (status.state === 'missing') {
        if (!(await this.isContainerBot(botKey))) return true; // runs without a bot container: nothing to wake
        this.logger.error(`Cannot wake bot ${botKey}: container is missing`);
        return false;
      }

      // Container is stopped or unhealthy - start it
      this.logger.info(`Waking up stopped container for bot ${botKey} (state=${status.state})`);
      this.startupTimes.set(botKey, Date.now());

      await this.driver.start(botKey);

      // driver.start() already waits for healthy, but we verify
      const finalStatus = await this.driver.status(botKey);
      const isHealthy = finalStatus.state === 'running';

      const startupTime = this.startupTimes.get(botKey);
      if (startupTime) {
        const coldStartDuration = Date.now() - startupTime;
        this.logger.info(`Cold start completed for bot ${botKey}: ${coldStartDuration}ms`);
        this.startupTimes.delete(botKey);
      }

      if (!isHealthy) {
        this.logger.error(`Bot ${botKey} failed to become healthy after start (state=${finalStatus.state})`);
      }

      return isHealthy;
    } catch (error) {
      this.logger.error(`Error during wake process for bot ${botKey}:`, error);
      return false;
    }
  }

  /**
   * Ensures a bot container is started and healthy before running a job.
   * Throws an error with a clear message if the container cannot be started
   * within the configured timeout.
   */
  public async ensureStartedAndHealthy(botKey: string): Promise<void> {
    const config = await this.currentConfig();
    const startTime = Date.now();
    const timeoutMs = config.healthTimeoutMs;

    try {
      const status = await this.driver.status(botKey);

      // Switched off: only a container IDLE-STOP stopped earlier is brought back.
      if (!config.enabled && !(status.idleStopped && status.state !== 'running')) return;

      if (status.state === 'running') {
        return;
      }

      if (status.state === 'missing') {
        // Agents without a bot container (no adapterConfig.container, or another adapter such as
        // antigravity_local) run in the server itself; IDLE-STOP has nothing to start for them.
        if (!(await this.isContainerBot(botKey))) return;
        throw new Error(`Container for bot ${botKey} is missing - cannot start`);
      }

      this.logger.info(`Starting container for bot ${botKey} (state=${status.state})`);
      this.startupTimes.set(botKey, Date.now());

      // Start with timeout
      await this.withTimeout(this.driver.start(botKey), timeoutMs, `Container start for bot ${botKey}`);

      // Verify healthy
      const finalStatus = await this.driver.status(botKey);
      if (finalStatus.state !== 'running') {
        throw new Error(`Container for bot ${botKey} failed to become healthy (state=${finalStatus.state})`);
      }

      const startupTime = this.startupTimes.get(botKey);
      if (startupTime) {
        const coldStartDuration = Date.now() - startupTime;
        this.logger.info(`Cold start completed for bot ${botKey}: ${coldStartDuration}ms`);
        this.startupTimes.delete(botKey);
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs || (error instanceof Error && error.message.includes('timed out after'))) {
        this.logger.error(`Timeout waiting for bot ${botKey} to become healthy after ${elapsed}ms`);
        throw new Error(`Timeout waiting for container health: bot ${botKey} did not become healthy within ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }
}
