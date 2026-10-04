// server/src/myrmidon/bot-containers/bot-quota.ts
//
// myrmidon(1.6.1-BOT-DISK-C): per-bot disk quota — size accounting, the attention
// signal registry and the admission check that refuses a NEW workspace clone for
// a bot already over its quota.
//
// What a bot owns on the host: `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>/{hermes,
// workspace,scratch}` (see BOT_VOLUME_MOUNTS in template.ts; botKey is the agent
// id, see agent-config.ts). The quota is that directory's size. The board sees
// the volume root only when it runs on the host that holds it; with no root
// configured the feature is inert (no measurement, no signal, no rejection),
// exactly like the BOT-DISK-A lifecycle behaves in the same situation.
//
// The measurement walk follows the pattern of workspace-hygiene/measure.ts
// (caps on depth/entries/time, symlinks measured but never followed, hardlinked
// inodes counted once) but is kept local to this module: workspace-hygiene is
// owned by part A and its internals are not imported without coordination.
//
// The signal goes through the attention vector: the sweep records one signal
// per bot into this module's process-level registry (the same delivery the
// stale-block and model-fallback features use), and the feed generator turns
// the registry into cards. Nothing is persisted for the signal.

import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  BOT_DISK_QUOTA_SETTINGS_KEY,
  botDiskQuotaDedupKey,
  botDiskQuotaRejectionMessage,
  isBotApproachingQuota,
  isBotOverQuota,
  normalizeBotDiskQuotaSettings,
  resolveBotDiskQuotaMb,
  type BotDiskQuotaSettings,
  type BotDiskQuotaSignal,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { botKeyForAgent, readBotContainerAgentConfig } from "./agent-config.js";

/** The env var naming the host directory that holds one subdirectory per bot. */
export const BOT_VOLUME_ROOT_ENV = "MYRMIDON_BOT_VOLUME_ROOT";

/** Stop the walk after this many entries; a bot volume stays measurable, not exact. */
const SIZE_MAX_ENTRIES = 200_000;
/** Stop descending at this depth; the deepest directories are counted by name only. */
const SIZE_MAX_DEPTH = 32;
/** Stop the walk after this long; a slow disk must not hold the scheduler tick. */
const SIZE_MAX_MS = 5_000;

export interface BotVolumeSizeMeasurement {
  sizeBytes: number;
  /** True when the walk stopped at a cap: `sizeBytes` is a lower bound. */
  truncated: boolean;
}

/**
 * The quota settings in force, read from the instance settings row. Absent or
 * unreadable means "no quota" — the check is skipped and no signal is raised.
 */
export async function readBotDiskQuotaSettings(db: Db): Promise<BotDiskQuotaSettings> {
  const general = await instanceSettingsService(db).getGeneral();
  return normalizeBotDiskQuotaSettings(general[BOT_DISK_QUOTA_SETTINGS_KEY]);
}

/** True when the settings could limit any bot at all (a cheap sweep skip). */
export function hasAnyQuota(settings: BotDiskQuotaSettings): boolean {
  return settings.defaultQuotaMb !== null || settings.perCaste.length > 0 || settings.perAgent.length > 0;
}

/**
 * Measure one bot's volume directory. A missing directory measures 0 bytes:
 * a bot that has never written anything is not over quota.
 */
export async function measureBotVolumeSize(botVolumePath: string): Promise<BotVolumeSizeMeasurement> {
  const deadline = Date.now() + SIZE_MAX_MS;
  const seenInodes = new Set<string>();
  let sizeBytes = 0;
  let entries = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdirectory: count nothing for it, keep the walk alive
    }
    for (const dirent of dirents) {
      if (truncated) return;
      if (++entries > SIZE_MAX_ENTRIES || Date.now() > deadline) {
        truncated = true;
        return;
      }
      const full = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) {
        try {
          const stat = await fs.lstat(full);
          sizeBytes += stat.size;
        } catch {
          /* unreadable link: skip */
        }
        continue; // symlinks are measured but never followed
      }
      if (dirent.isDirectory()) {
        if (depth >= SIZE_MAX_DEPTH) {
          truncated = true;
          return;
        }
        await walk(full, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      try {
        const stat = await fs.stat(full);
        // A file with more than one hard link (a pnpm store imported by hardlinks
        // across bots) counts once per inode for the whole process of measuring
        // this bot; other bots measure their own copy of the shared store.
        if (stat.nlink > 1) {
          const inodeKey = `${stat.dev}:${stat.ino}`;
          if (seenInodes.has(inodeKey)) continue;
          seenInodes.add(inodeKey);
        }
        sizeBytes += stat.size;
      } catch {
        /* file raced away mid-walk: skip */
      }
    }
  }

  await walk(botVolumePath, 0);
  return { sizeBytes, truncated };
}

// ---------------------------------------------------------------------------
// The admission check (refuse a NEW clone before the directory is created)
// ---------------------------------------------------------------------------

/**
 * The per-bot quota on the agent card (`container.diskQuotaMb`, parsed by
 * agent-config.ts), or null when the card does not set one. A card override
 * wins over the instance settings.
 */
export function cardDiskQuotaMb(agent: { adapterType: string; adapterConfig: Record<string, unknown> }): number | null {
  const parsed = readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig);
  return parsed.ok ? (parsed.config.diskQuotaMb ?? null) : null;
}

/**
 * The quota check for one agent before a new execution workspace is created.
 * Returns the rejection message when the bot is over quota, or null when the
 * clone may proceed. Every "cannot decide" path (no volume root env, no quota
 * for this agent, unknown agent, failed measurement) returns null: the quota
 * refuses work only when it is certain, never on a technicality.
 */
export async function botDiskQuotaRejection(
  db: Db | null | undefined,
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!db || !agentId) return null;
  const volumeRoot = env[BOT_VOLUME_ROOT_ENV]?.trim();
  if (!volumeRoot) return null;
  const botKey = botKeyForAgent(agentId);
  if (!botKey) return null;

  try {
    const agent = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .then((rows: {
        id: string;
        name: string;
        role: string | null;
        adapterType: string;
        adapterConfig: Record<string, unknown>;
      }[]) => rows[0] ?? null);
    if (!agent) return null;

    const cardQuotaMb = cardDiskQuotaMb(agent);
    let quotaMb = cardQuotaMb;
    if (quotaMb === null) {
      const settings = await readBotDiskQuotaSettings(db);
      if (!hasAnyQuota(settings)) return null;
      quotaMb = resolveBotDiskQuotaMb(settings, agent.id, agent.role);
    }
    if (quotaMb === null) return null;

    const { sizeBytes } = await measureBotVolumeSize(path.join(volumeRoot, botKey));
    if (!isBotOverQuota(sizeBytes, quotaMb)) return null;
    return botDiskQuotaRejectionMessage({ agentName: agent.name, usageBytes: sizeBytes, quotaMb });
  } catch (error) {
    logger.warn(
      { err: error, agentId },
      "bot disk quota admission check failed; allowing the workspace",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process-level signal registry the attention feed reads
// ---------------------------------------------------------------------------

const signalsByCompany = new Map<string, BotDiskQuotaSignal[]>();

/** Records one sweep's signals for a company; an empty list clears them. */
export function recordBotDiskQuotaSignals(companyId: string, signals: BotDiskQuotaSignal[]): void {
  if (signals.length === 0) {
    signalsByCompany.delete(companyId);
    return;
  }
  signalsByCompany.set(companyId, signals);
}

/** The company's current quota signals, or an empty array when none. */
export function readBotDiskQuotaSignals(companyId: string): BotDiskQuotaSignal[] {
  return signalsByCompany.get(companyId) ?? [];
}

/** Test helper: forget every recorded signal. */
export function resetBotDiskQuotaSignalsForTests(): void {
  signalsByCompany.clear();
}

export { botDiskQuotaDedupKey, isBotApproachingQuota, isBotOverQuota };
