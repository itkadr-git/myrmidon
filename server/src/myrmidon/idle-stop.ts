import { BotContainerDriver, BotContainerStatus } from './bot-containers/driver.js';
import { Db, heartbeatRuns, agents } from '@paperclipai/db';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';

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
      enabled: config.enabled ?? false,
      afterSec: config.afterSec ?? 1800, // 30 minutes default
      healthTimeoutMs: config.healthTimeoutMs ?? 30000,
      sweepIntervalMs: config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    };
  }

  public start(): void {
    if (!this.config.enabled) {
      this.logger.info('IDLE-STOP service disabled, not starting');
      return;
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
    if (!this.config.enabled) {
      return;
    }

    try {
      this.logger.debug('Starting idle container sweep');

      const botKeys = await this.listBotKeys();
      if (botKeys.length === 0) {
        this.logger.debug('No bot container agents found, skipping sweep');
        return;
      }

      const containers = await this.driver.list(botKeys);
      this.logger.debug(`Found ${containers.length} bot containers`);

      for (const container of containers) {
        await this.checkContainer(container);
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
  private async listBotKeys(): Promise<string[]> {
    try {
      const rows = await this.db
        .select({ agentId: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.adapterType, 'hermes_gateway'),
            sql`${agents.status} != 'terminated'`,
            sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
          ),
        );
      return rows.map((row) => row.agentId);
    } catch (error) {
      this.logger.error('Error listing bot container agents:', error);
      return [];
    }
  }

  private async checkContainer(container: BotContainerStatus): Promise<void> {
    const botKey = container.botKey;

    // Only stop running containers
    if (container.state !== 'running') {
      this.logger.debug(`Bot ${botKey} is not running (state=${container.state}), skipping`);
      return;
    }

    const hasActiveRuns = await this.hasActiveRuns(botKey);
    if (hasActiveRuns) {
      this.logger.debug(`Bot ${botKey} has active runs, skipping`);
      return;
    }

    const idleDurationSec = await this.getIdleDurationSec(botKey);
    if (idleDurationSec < this.config.afterSec) {
      this.logger.debug(
        `Bot ${botKey} is idle but not long enough (${idleDurationSec}s/${this.config.afterSec}s)`,
      );
      return;
    }

    this.logger.info(`Stopping idle container for bot ${botKey} (idle for ${idleDurationSec}s)`);
    try {
      await this.driver.stop(botKey);
    } catch (error) {
      this.logger.error(`Failed to stop container for bot ${botKey}:`, error);
    }
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
  private async getIdleDurationSec(botKey: string): Promise<number> {
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

      const idleMs = Date.now() - new Date(lastActivity).getTime();
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
    if (!this.config.enabled) {
      // IDLE-STOP disabled: no-op passthrough, never touch the driver
      return true;
    }

    try {
      const status = await this.driver.status(botKey);

      if (status.state === 'running') {
        this.logger.debug(`Bot ${botKey} is already running`);
        return true;
      }

      if (status.state === 'missing') {
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
    if (!this.config.enabled) {
      return;
    }

    const startTime = Date.now();
    const timeoutMs = this.config.healthTimeoutMs;

    try {
      const status = await this.driver.status(botKey);

      if (status.state === 'running') {
        return;
      }

      if (status.state === 'missing') {
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
      if (elapsed >= timeoutMs) {
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
