// server/src/myrmidon/bot-containers/bot-disk-quota-sweep.ts
//
// myrmidon(1.6.1-BOT-DISK-C): the periodic bot-volume measurement. It runs from
// the server's maintenance tick, next to the workspace-hygiene sweep, and follows
// the same bounded pattern (one page per tick, a per-bot remeasure interval, a
// wall-clock budget): measuring every bot volume in one tick would hold the
// shared scheduler on a slow disk.
//
// myrmidon(1.6.5-BOT-DISK-H9c): the sweep also enforces the quotas it resolves.
// Once per tick it reads the physical disk state from dockergate (GET
// /myrmidon/disk, contract C5) and, for every bot of the page, puts the resolved
// quota as the hard xfs project limit (PUT .../quota) when it differs from the
// last one applied. Usage for the 80 %/100 % signals is the physical project
// figure; with quotas off on the partition (or no answer from the gate) the old
// du walk is the estimate and the signal says so. An unreachable dockergate never
// fails the tick: it just means "no enforcement, estimate usage" for that tick.
//
// The sweep is a signal, not a reaper: it never deletes anything. What it does
// with the measurements it took — bots at or over their quota — it records into
// the process-level registry in bot-quota.ts, and the attention feed turns those
// into cards. Over-quota bots additionally get their new clones refused at the
// admission check (bot-quota.ts); this sweep is what makes the board see it.

import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  BOT_DISK_QUOTA_APPROACHING_RATIO,
  WS_QUOTA_MAX_BYTES,
  WS_QUOTA_MIN_BYTES,
  botDiskQuotaDedupKey,
  resolveBotDiskQuotaMb,
  type BotDiskQuotaSettings,
  type BotDiskQuotaSignal,
  type WsDiskApiResponse,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { botKeyForAgent } from "./agent-config.js";
import {
  BOT_VOLUME_ROOT_ENV,
  cardDiskQuotaMb,
  measureBotDiskUsage,
  readDockergateDiskOrNull,
  recordBotDiskQuotaSignals,
} from "./bot-quota.js";
import { dockergateDiskClientFromEnv, type DockergateDiskClient } from "./dockergate-disk-client.js";

const MIB = 1024 * 1024;

/** Author of the sweep's log lines. */
export const BOT_DISK_QUOTA_SWEEP_ACTOR_ID = "bot_disk_quota_sweep";

/** Bots measured per tick. */
export const BOT_DISK_QUOTA_DEFAULT_PAGE_SIZE = 20;
/** A bot volume is not measured again within this window. */
export const BOT_DISK_QUOTA_DEFAULT_REMEASURE_MS = 10 * 60 * 1000;
/** The whole sweep stops after this long, whatever is left in the page. */
export const BOT_DISK_QUOTA_DEFAULT_MAX_SWEEP_MS = 15_000;

export interface BotDiskQuotaSweepResult {
  /** ISO timestamp when this sweep started. */
  at: string;
  /** Rows taken from the rotation in this tick. */
  scanned: number;
  measured: number;
  /** Bots with no quota set — not walked at all. */
  skippedNoQuota: number;
  failed: number;
  /** H9c: quota PUTs sent to dockergate in this tick. */
  quotaPut: number;
  /** H9c: quota PUTs dockergate refused or that did not arrive. */
  quotaPutFailed: number;
  /** H9c: whether the physical disk state of dockergate was available in this tick. */
  physicalAvailable: boolean;
  /** Bots with a live signal after this tick (approaching or over quota). */
  signalling: number;
  elapsedMs: number;
}

export interface BotDiskQuotaSweep {
  sweep(): Promise<BotDiskQuotaSweepResult>;
  /** The result of the last finished sweep, or null before the first one. */
  lastResult(): BotDiskQuotaSweepResult | null;
}

function emptyResult(at: string): BotDiskQuotaSweepResult {
  return { at, scanned: 0, measured: 0, skippedNoQuota: 0, failed: 0, quotaPut: 0, quotaPutFailed: 0, physicalAvailable: false, signalling: 0, elapsedMs: 0 };
}

export function createBotDiskQuotaSweep(deps: {
  db: Db;
  /** Quotas in force; read at the top of every tick, so a PATCH applies at once. */
  resolveSettings: () => Promise<BotDiskQuotaSettings>;
  /** Defaults to process.env; tests inject the volume root. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pageSize?: number;
  remeasureIntervalMs?: number;
  maxSweepMs?: number;
  /** H9c: the dockergate disk client; null turns the physical path off. Defaults to the env socket. */
  gate?: Pick<DockergateDiskClient, "getDisk" | "putQuota"> | null;
}): BotDiskQuotaSweep {
  const gate = deps.gate === undefined ? dockergateDiskClientFromEnv(deps.env ?? process.env) : deps.gate;
  const env = deps.env ?? process.env;
  const pageSize = deps.pageSize ?? BOT_DISK_QUOTA_DEFAULT_PAGE_SIZE;
  const maxSweepMs = deps.maxSweepMs ?? BOT_DISK_QUOTA_DEFAULT_MAX_SWEEP_MS;
  const now = deps.now ?? (() => new Date());
  /** (agent id) -> last measurement; process-scoped like the signal registry. */
  const lastMeasuredAt = new Map<string, number>();
  /** (agent id) -> hard quota bytes last put to dockergate (or found already in force). */
  const lastApplied = new Map<string, number>();
  /** (agent id) -> when the last failed PUT was; a failed bot is retried after the remeasure interval. */
  const lastPutFailedAt = new Map<string, number>();
  /** Live signals per company, kept across the ticks of one rotation. */
  const accumulated = new Map<string, Map<string, BotDiskQuotaSignal>>();
  /** keyset cursor of the rotation; null means "start at the head". */
  let cursor: { updatedAt: Date; id: string } | null = null;

  let lastResult: BotDiskQuotaSweepResult | null = null;
  let inFlight: Promise<BotDiskQuotaSweepResult> | null = null;

  function clearAllSignals(): void {
    for (const companyId of accumulated.keys()) recordBotDiskQuotaSignals(companyId, []);
    accumulated.clear();
  }

  async function runSweep(): Promise<BotDiskQuotaSweepResult> {
    const startedAt = now().getTime();
    const result = emptyResult(new Date(startedAt).toISOString());
    const volumeRoot = env[BOT_VOLUME_ROOT_ENV]?.trim() || null;
    const disk = gate ? await readDockergateDiskOrNull(gate) : null;
    result.physicalAvailable = disk?.quotaEnabled === true;
    if (!volumeRoot && !disk) {
      // The board cannot see the bot volumes from here and dockergate gave no
      // numbers; there is nothing to measure and no stale signal to keep.
      clearAllSignals();
      lastResult = result;
      return result;
    }
    const settings = await deps.resolveSettings();
    // hasAnyQuota alone would skip bots whose only quota is a card override
    // (`container.diskQuotaMb`), so the per-row resolution below decides.
    const remeasureIntervalMs = deps.remeasureIntervalMs ?? BOT_DISK_QUOTA_DEFAULT_REMEASURE_MS;

    // One page of agents in (updatedAt, id) order after the rotation cursor;
    // when the tail is reached the cursor resets and the next tick restarts.
    const rows = await deps.db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        role: agents.role,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(
        cursor
          ? or(
              gt(agents.updatedAt, cursor.updatedAt),
              and(eq(agents.updatedAt, cursor.updatedAt), gt(agents.id, cursor.id)),
            )
          : undefined,
      )
      .orderBy(asc(agents.updatedAt), asc(agents.id))
      .limit(pageSize);
    cursor = rows.length < pageSize ? null : { updatedAt: rows[rows.length - 1].updatedAt, id: rows[rows.length - 1].id };

    for (const agent of rows) {
      if (now().getTime() - startedAt > maxSweepMs) break;
      result.scanned += 1;
      // the card override (`container.diskQuotaMb`) wins over the instance settings
      const quotaMb = cardDiskQuotaMb(agent) ?? resolveBotDiskQuotaMb(settings, agent.id, agent.role);
      if (quotaMb === null) {
        result.skippedNoQuota += 1;
        // A bot that lost its quota must not keep a stale signal from before.
        accumulated.get(agent.companyId)?.delete(agent.id);
        continue;
      }
      await applyQuota(agent.id, quotaMb, disk, startedAt, result);
      const botKey = botKeyForAgent(agent.id) ?? agent.id;
      const physical = disk?.quotaEnabled ? disk.projects.some((project) => project.botKey === botKey) : false;
      const previousAt = lastMeasuredAt.get(agent.id);
      // The physical figure is already in hand and free; only the du walk is throttled.
      if (!physical && previousAt !== undefined && startedAt - previousAt < remeasureIntervalMs) continue;
      let sizeBytes: number;
      let usageSource: "physical" | "estimate";
      try {
        const usage = await measureBotDiskUsage({ botKey, disk, volumeRoot });
        if (!usage) continue;
        ({ sizeBytes, source: usageSource } = usage);
      } catch (error) {
        result.failed += 1;
        logger.warn({ err: error, agentId: agent.id }, "bot disk quota sweep could not measure a bot volume");
        continue;
      }
      result.measured += 1;
      lastMeasuredAt.set(agent.id, startedAt);
      accumulate(agent, quotaMb, sizeBytes, startedAt, usageSource);
    }

    // Publish the rotation state: every company keeps the signals of the bots
    // the rotation has measured so far, refreshed as later ticks re-measure them.
    const tracked = new Set<string>();
    for (const [companyId, byAgent] of accumulated) {
      recordBotDiskQuotaSignals(companyId, [...byAgent.values()]);
      for (const agentId of byAgent.keys()) tracked.add(agentId);
      result.signalling += byAgent.size;
    }
    // prune bots that no longer exist at all (deleted agents never re-enter the
    // rotation, so without this the registry would leak one entry per removed bot)
    if (tracked.size > 0) {
      const alive = await deps.db
        .select({ id: agents.id })
        .from(agents)
        .where(inArray(agents.id, [...tracked]))
        .then((rows: { id: string }[]) => new Set(rows.map((row) => row.id)));
      for (const [, byAgent] of accumulated) {
        for (const agentId of [...byAgent.keys()]) if (!alive.has(agentId)) byAgent.delete(agentId);
      }
    }

    result.elapsedMs = Math.max(0, now().getTime() - startedAt);
    if (result.measured > 0 || result.quotaPut > 0 || result.quotaPutFailed > 0) {
      logger.info({ ...result }, "bot disk quota sweep measured bot volumes");
    }
    lastResult = result;
    return result;
  }

  /** Puts the resolved quota as the hard limit when it is not the one last applied. */
  async function applyQuota(
    agentId: string,
    quotaMb: number,
    disk: WsDiskApiResponse | null,
    nowMs: number,
    result: BotDiskQuotaSweepResult,
  ): Promise<void> {
    // No gate answer, or quotas off on the partition: nothing can be enforced.
    if (!gate || !disk?.quotaEnabled) return;
    const botKey = botKeyForAgent(agentId);
    if (!botKey) return;
    const bytes = Math.min(WS_QUOTA_MAX_BYTES, Math.max(WS_QUOTA_MIN_BYTES, quotaMb * MIB));
    if (lastApplied.get(agentId) === bytes) return;
    const project = disk.projects.find((candidate) => candidate.botKey === botKey);
    if (project && project.hardBytes === bytes) {
      lastApplied.set(agentId, bytes); // already in force on the partition
      return;
    }
    const failedAt = lastPutFailedAt.get(agentId);
    if (failedAt !== undefined && nowMs - failedAt < (deps.remeasureIntervalMs ?? BOT_DISK_QUOTA_DEFAULT_REMEASURE_MS)) return;
    try {
      await gate.putQuota(botKey, bytes);
      lastApplied.set(agentId, bytes);
      lastPutFailedAt.delete(agentId);
      result.quotaPut += 1;
    } catch (error) {
      lastPutFailedAt.set(agentId, nowMs);
      result.quotaPutFailed += 1;
      logger.warn({ err: error, agentId }, "bot disk quota sweep could not put the quota to dockergate");
    }
  }

  function accumulate(
    agent: { id: string; companyId: string },
    quotaMb: number,
    sizeBytes: number,
    observedAtMs: number,
    usageSource: "physical" | "estimate",
  ): void {
    const quotaBytes = quotaMb * 1024 * 1024;
    const over = sizeBytes > quotaBytes;
    const approaching = sizeBytes >= quotaBytes * BOT_DISK_QUOTA_APPROACHING_RATIO;
    let byAgent = accumulated.get(agent.companyId);
    if (!byAgent) {
      byAgent = new Map();
      accumulated.set(agent.companyId, byAgent);
    }
    if (!over && !approaching) {
      byAgent.delete(agent.id);
      return;
    }
    byAgent.set(agent.id, {
      agentId: agent.id,
      dedupKey: botDiskQuotaDedupKey(agent.id),
      overQuota: over,
      usageBytes: sizeBytes,
      quotaMb,
      observedAtMs,
      usageSource,
    });
  }

  return {
    sweep: () => {
      // A tick that arrives while a sweep runs joins it instead of walking the
      // same bot volumes twice.
      if (inFlight) return inFlight;
      inFlight = runSweep().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    lastResult: () => lastResult,
  };
}
