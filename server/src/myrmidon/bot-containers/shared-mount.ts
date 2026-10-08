// myrmidon(1.6.1 BOT-DISK-D): the shared directory every allowed bot sees at
// `/shared`. This file holds the pure rules (who gets it, where it lives on the
// host) and the best-effort host-side preparation. The bind itself is made by
// template.ts (`withSharedMount`) from the create body, so it is part of the
// drift check and reaches existing containers through the normal recreate path.

import fs from "node:fs/promises";
import path from "node:path";
import type { SharedMountSettings } from "@paperclipai/shared";
import type { BotSharedMount } from "./driver.js";

/** Default shared mount settings: off. */
export const DEFAULT_SHARED_MOUNT_SETTINGS: SharedMountSettings = {
  enabled: false,
  writable: false,
  allowedBots: [],
};

/** Effective settings: the stored ones over the defaults. */
export function getEffectiveSharedMountSettings(
  settings: Partial<SharedMountSettings> | undefined,
): SharedMountSettings {
  return {
    ...DEFAULT_SHARED_MOUNT_SETTINGS,
    ...settings,
    allowedBots: settings?.allowedBots ?? DEFAULT_SHARED_MOUNT_SETTINGS.allowedBots,
  };
}

/** Whether a bot may use the shared directory. An empty allowlist means every bot. */
export function isBotAllowedSharedAccess(botId: string, settings: SharedMountSettings): boolean {
  if (!settings.enabled) return false;
  if (!settings.allowedBots || settings.allowedBots.length === 0) return true;
  return settings.allowedBots.includes(botId);
}

/** Host directory of the shared mount: the setting, else `<volumeRoot>/shared`. */
export function getSharedMountHostPath(
  settings: Pick<SharedMountSettings, "hostPath">,
  volumeRoot: string = process.env.MYRMIDON_BOT_VOLUME_ROOT || "/var/lib/myrmidon-bots",
): string {
  return settings.hostPath || path.join(volumeRoot, "shared");
}

/**
 * The shared mount one bot gets, or undefined. `botId` is the agent id (the
 * allowlist names agents). A bot without an id never matches an allowlist but
 * matches an open (empty) one.
 */
export function resolveBotSharedMount(
  botId: string | undefined,
  stored: Partial<SharedMountSettings> | undefined,
): BotSharedMount | undefined {
  if (!stored) return undefined;
  const settings = getEffectiveSharedMountSettings(stored);
  if (!settings.enabled) return undefined;
  const open = !settings.allowedBots || settings.allowedBots.length === 0;
  if (!open && (botId === undefined || !isBotAllowedSharedAccess(botId, settings))) return undefined;
  return {
    ...(settings.hostPath ? { hostPath: settings.hostPath } : {}),
    writable: settings.writable === true,
  };
}

/** The mount with its host path made concrete (the driver's volume root fills the default). */
export function resolveSpecSharedMount(
  spec: { sharedMount?: BotSharedMount },
  volumeRoot: string,
): { hostPath: string; writable: boolean } | undefined {
  if (!spec.sharedMount) return undefined;
  return {
    hostPath: getSharedMountHostPath({ hostPath: spec.sharedMount.hostPath }, volumeRoot),
    writable: spec.sharedMount.writable,
  };
}

/**
 * Creates the shared directory when it is missing (mode 0750, or 0770 when it
 * is writable). An existing directory is never touched: its owner and mode
 * are the operator's.
 */
export async function ensureSharedDirectory(hostPath: string, writable: boolean): Promise<void> {
  try {
    await fs.access(hostPath);
    return;
  } catch {
    // missing: create it
  }
  const mode = writable ? 0o770 : 0o750;
  await fs.mkdir(hostPath, { recursive: true, mode });
  await fs.chmod(hostPath, mode);
}

export interface SharedMigrationResult {
  moved: string[];
  /** Items left in the bot's old directory (name clash or failed rename). */
  kept: string[];
}

/**
 * Moves what an old per-bot copy left in `<botVolume>/shared` into the shared
 * directory. NON-DESTRUCTIVE by construction: an item moves only when nothing
 * of that name is in the shared directory yet and the rename succeeds; every
 * other item stays where it was, and the old directory is removed only when it
 * ended up empty (`rmdir`, which refuses a non-empty directory). A symlink
 * there is not an old copy and is left alone. No symlink is created: a link
 * to a host path cannot resolve inside the container; the bind does the job.
 */
export async function migrateHardlinkCopies(
  botVolumePath: string,
  sharedHostPath: string,
): Promise<SharedMigrationResult> {
  const result: SharedMigrationResult = { moved: [], kept: [] };
  const oldDir = path.join(botVolumePath, "shared");
  let stat;
  try {
    stat = await fs.lstat(oldDir);
  } catch {
    return result; // no old directory, nothing to migrate
  }
  if (!stat.isDirectory()) return result; // a symlink or a file is not an old copy

  for (const item of await fs.readdir(oldDir)) {
    const source = path.join(oldDir, item);
    const target = path.join(sharedHostPath, item);
    let clash = true;
    try {
      await fs.lstat(target);
    } catch {
      clash = false;
    }
    if (clash) {
      result.kept.push(item);
      continue;
    }
    try {
      await fs.rename(source, target);
      result.moved.push(item);
    } catch {
      result.kept.push(item);
    }
  }
  if (result.kept.length === 0) {
    try {
      await fs.rmdir(oldDir);
    } catch {
      // not empty or not removable: leave it
    }
  }
  return result;
}

/**
 * Host side of the mount for one bot, best effort: never throws, the problems
 * come back as warnings. Docker creates a missing bind source on its own, so a
 * failure here costs only the permissions and the one-time migration.
 */
export async function prepareBotSharedMount(
  botVolumePath: string,
  mount: { hostPath: string; writable: boolean },
): Promise<{ warnings: string[]; migration: SharedMigrationResult }> {
  const warnings: string[] = [];
  let migration: SharedMigrationResult = { moved: [], kept: [] };
  try {
    await ensureSharedDirectory(mount.hostPath, mount.writable);
  } catch (err) {
    warnings.push(`could not create ${mount.hostPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { warnings, migration };
  }
  try {
    migration = await migrateHardlinkCopies(botVolumePath, mount.hostPath);
    if (migration.kept.length > 0) {
      warnings.push(`kept ${migration.kept.length} item(s) in ${path.join(botVolumePath, "shared")} (name clash or failed move)`);
    }
  } catch (err) {
    warnings.push(`migration of ${path.join(botVolumePath, "shared")} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { warnings, migration };
}
