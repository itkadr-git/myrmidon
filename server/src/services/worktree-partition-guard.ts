// myrmidon(1.6.9, OPE-13213): a board-side git worktree is never created on a
// partition that is already past the bot-disk "refuse open" threshold.
//
// The board creates worktrees only for adapters that run on the board host
// (local adapters). The threshold is the one every other workspace on the bot
// disk obeys: `general.botDisk.partitionRefuseOpenPercent` (default 90).
// A partition that cannot be measured never blocks: no data is not a refusal.

import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@myrmidon/db";
import { WS_BOT_DISK_SETTING_DEFAULTS, resolveWsBotDiskPartitionSettings } from "@myrmidon/shared";
import { instanceSettingsService } from "./instance-settings.js";

export const WORKTREE_PARTITION_FULL_REASON_CODE = "WORKTREE_PARTITION_FULL";

/** Used percent of the partition that holds `dir` (or its nearest existing parent); null when unmeasurable. */
export async function measurePartitionUsedPercent(dir: string): Promise<number | null> {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stat = await fs.statfs(current);
      // df semantics: used / (used + available to unprivileged users).
      const used = stat.blocks - stat.bfree;
      const total = used + stat.bavail;
      if (!Number.isFinite(total) || total <= 0) return null;
      return (used / total) * 100;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

export async function resolveRefuseOpenPercent(db: Db | null | undefined): Promise<number> {
  if (!db) return WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent;
  try {
    const general = (await instanceSettingsService(db).getGeneral()) as unknown as Record<string, unknown>;
    return resolveWsBotDiskPartitionSettings({ stored: general.botDisk, env: process.env }).settings
      .partitionRefuseOpenPercent;
  } catch {
    return WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent;
  }
}

export interface WorktreePartitionRefusalInput {
  db?: Db | null;
  worktreeParentDir: string;
  /** Test seam: replaces the statfs measurement. */
  measure?: ((dir: string) => Promise<number | null>) | null;
}

/** The refusal message when the partition is at or above the threshold, else null. */
export async function worktreePartitionRefusal(input: WorktreePartitionRefusalInput): Promise<string | null> {
  const usedPercent = await (input.measure ?? measurePartitionUsedPercent)(input.worktreeParentDir);
  if (usedPercent === null) return null;
  const refuseAt = await resolveRefuseOpenPercent(input.db);
  if (usedPercent < refuseAt) return null;
  return (
    `${WORKTREE_PARTITION_FULL_REASON_CODE}: the partition that holds "${input.worktreeParentDir}" is ` +
    `${usedPercent.toFixed(1)}% full, at or above the refuse-open threshold of ${refuseAt}% ` +
    `(general.botDisk.partitionRefuseOpenPercent); no new git worktree is created. ` +
    `Free disk space or raise the threshold in the bot disk settings, then retry.`
  );
}
