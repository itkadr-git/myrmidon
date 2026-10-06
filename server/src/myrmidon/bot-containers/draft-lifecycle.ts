import { readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { findRepos, noteVolumeRoot } from './clone-hygiene.js'; // myrmidon(1.6.2-BOT-DISK-C)

// Default idle TTL is 6 hours in milliseconds
const DEFAULT_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

interface BotDiskLifecycleConfig {
  enabled: boolean;
  idleTtlMs: number;
  defaultIdleTtlMs: number;
}

/**
 * myrmidon(FEATURES): what one sweep did, so the operator can see whether it
 * works. The sweep still logs and swallows its errors (a bad directory must not
 * stop the next one); the report is how they reach the features page.
 */
export interface BotDiskSweepReport {
  /** The volume root could not be listed (for example it does not exist). */
  rootError: { code: string | null; message: string } | null;
  /** Draft directories removed in this pass. */
  reaped: number;
  /** Directories that could not be read or removed. */
  errors: number;
  firstError: string | null;
  /** The pass was skipped because the lifecycle is switched off. */
  skipped: boolean;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks if a directory is considered alive by looking for process group markers
 */
async function isAliveDirectory(dirPath: string): Promise<boolean> {
  // Check for run-scratch.ts markers indicating an active run
  const heartbeatMarker = join(dirPath, '.heartbeat');
  try {
    await stat(heartbeatMarker);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determines if a directory is a scratch or workspace directory that should be cleaned up
 */
function isCleanupCandidate(dirPath: string): boolean {
  // Check if this is a bot volume directory containing scratch or workspace
  const pathSegments = dirPath.split('/');
  const isScratchOrWorkspace = pathSegments.includes('scratch') || pathSegments.includes('workspace');
  const isHermesDir = pathSegments.includes('hermes'); // Don't clean hermes directories
  
  return isScratchOrWorkspace && !isHermesDir;
}

/**
 * Gets the last modification time of a directory
 */
async function getLastModifiedTime(dirPath: string): Promise<number> {
  const stats = await stat(dirPath);
  return stats.mtime.getTime();
}

/**
 * Removes a directory if it's safe to do so
 */
async function safeRemoveDirectory(dirPath: string): Promise<boolean> {
  try {
    // Double-check this is a cleanup candidate before removing
    if (!isCleanupCandidate(dirPath)) {
      console.log(`Skipping removal of ${dirPath} - not a cleanup candidate`);
      return false;
    }

    console.log(`Removing directory: ${dirPath}`);
    await rm(dirPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error(`Failed to remove directory ${dirPath}:`, error);
    return false;
  }
}

/**
 * Sweeps a single bot volume root and cleans up stale directories
 */
export async function sweepBotVolume(
  botVolumeRoot: string,
  config: BotDiskLifecycleConfig
): Promise<BotDiskSweepReport> {
  const report: BotDiskSweepReport = { rootError: null, reaped: 0, errors: 0, firstError: null, skipped: false };
  if (!config.enabled) {
    console.log('Bot disk lifecycle is disabled, skipping sweep');
    report.skipped = true;
    return report;
  }
  const fail = (error: unknown) => {
    report.errors += 1;
    report.firstError ??= errorText(error);
  };

  // myrmidon(1.6.2-BOT-DISK-C): the board server has no mount of the bot volumes
  // in production (host mounts were removed from it in 1.3.0), so the root is
  // normally absent here: one warning, then a no-op. Clones are reaped inside
  // the bot containers (clone-hygiene.ts); this sweep is for a host where the
  // board does see the volumes, and it leaves git repositories to the reporter.
  try {
    await stat(botVolumeRoot);
    noteVolumeRoot(true, () => undefined);
  } catch {
    noteVolumeRoot(false, (message) => console.warn(message));
    return report;
  }

  try {
    const bots = await readdir(botVolumeRoot);
    
    for (const botKey of bots) {
      const botPath = join(botVolumeRoot, botKey);
      
      try {
        const botStats = await stat(botPath);
        if (!botStats.isDirectory()) {
          continue;
        }

        // Only scratch/ and workspace/ clones are cleanup candidates;
        // the hermes/ volume (memory + instructions) is never touched.
        for (const sub of ['scratch', 'workspace']) {
          const subPath = join(botPath, sub);
          try {
            const subStats = await stat(subPath);
            if (!subStats.isDirectory()) {
              continue;
            }
          } catch {
            continue; // no such subvolume on this bot
          }
          const entries = await readdir(subPath);
          for (const entry of entries) {
            // myrmidon(1.6.2-BOT-DISK-C): the bot's pnpm store (/workspace/.pnpm-store)
            // is what every clone's node_modules hard-links into; it is not a draft.
            if (entry === PNPM_STORE_ENTRY) continue;
            const entryPath = join(subPath, entry);
            const outcome = await reapIfStale(entryPath, config);
            if (outcome === 'reaped') report.reaped += 1;
            else if (outcome === 'failed') fail(new Error(`could not remove ${entryPath}`));
          }
        }
      } catch (error) {
        console.error(`Error processing bot volume ${botPath}:`, error);
        fail(error);
      }
    }
  } catch (error) {
    console.error(`Error sweeping bot volume ${botVolumeRoot}:`, error);
    report.rootError = { code: errorCode(error), message: errorText(error) };
  }
  return report;
}

async function reapIfStale(dirPath: string, config: BotDiskLifecycleConfig): Promise<'reaped' | 'failed' | 'kept'> {
  if (!isCleanupCandidate(dirPath)) {
    return 'kept';
  }
  // Skip if it's currently alive (has active run markers)
  if (await isAliveDirectory(dirPath)) {
    return 'kept';
  }
  // myrmidon(1.6.2-BOT-DISK-C): an entry that is, or holds, a git repository is
  // never reaped by its directory mtime (a commit or a tracked-file edit does not
  // touch it, so a busy clone looks idle): the bot's own reporter decides, knowing
  // whether the work is pushed (clone-hygiene.ts).
  if ((await findRepos(dirPath)).length > 0) {
    return 'kept';
  }
  const lastModified = await getLastModifiedTime(dirPath);
  const now = Date.now();
  const idleTime = now - lastModified;
  if (idleTime > config.idleTtlMs) {
    return (await safeRemoveDirectory(dirPath)) ? 'reaped' : 'failed';
  }
  return 'kept';
}

/** myrmidon(1.6.2-BOT-DISK-C): the workspace pnpm store entry (template.ts DEFAULT_PNPM_STORE_DIR). */
const PNPM_STORE_ENTRY = '.pnpm-store';

/**
 * Performs a sweep of all bot volumes in the system
 */
export async function sweepAllBotVolumes(config: BotDiskLifecycleConfig): Promise<BotDiskSweepReport> {
  const botVolumeRoot = process.env.MYRMIDON_BOT_VOLUME_ROOT || '/tmp/myrmidon-bots';
  
  console.log(`Starting bot disk lifecycle sweep with TTL: ${config.idleTtlMs}ms`);
  
  return sweepBotVolume(botVolumeRoot, config);
}

/**
 * Gets the default configuration for bot disk lifecycle
 */
export function getDefaultLifecycleConfig(): BotDiskLifecycleConfig {
  return {
    enabled: true,
    idleTtlMs: DEFAULT_IDLE_TTL_MS,
    defaultIdleTtlMs: DEFAULT_IDLE_TTL_MS,
  };
}