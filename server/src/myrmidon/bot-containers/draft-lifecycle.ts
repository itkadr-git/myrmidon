import { readdir, stat, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default idle TTL is 6 hours in milliseconds
const DEFAULT_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

interface BotDiskLifecycleConfig {
  enabled: boolean;
  idleTtlMs: number;
  defaultIdleTtlMs: number;
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
): Promise<void> {
  if (!config.enabled) {
    console.log('Bot disk lifecycle is disabled, skipping sweep');
    return;
  }

  try {
    const items = await readdir(botVolumeRoot);
    
    for (const item of items) {
      const itemPath = join(botVolumeRoot, item);
      
      try {
        const stats = await stat(itemPath);
        
        if (!stats.isDirectory()) {
          continue;
        }

        // Check if this is a directory we should consider for cleanup
        if (isCleanupCandidate(itemPath)) {
          // Skip if it's currently alive (has active run markers)
          if (await isAliveDirectory(itemPath)) {
            console.log(`Skipping alive directory: ${itemPath}`);
            continue;
          }

          // Get last modified time
          const lastModified = await getLastModifiedTime(itemPath);
          const now = Date.now();
          const idleTime = now - lastModified;
          
          // Remove if older than the TTL
          if (idleTime > config.idleTtlMs) {
            await safeRemoveDirectory(itemPath);
          }
        }
      } catch (error) {
        console.error(`Error processing directory ${itemPath}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error sweeping bot volume ${botVolumeRoot}:`, error);
  }
}

/**
 * Performs a sweep of all bot volumes in the system
 */
export async function sweepAllBotVolumes(config: BotDiskLifecycleConfig): Promise<void> {
  const botVolumeRoot = process.env.MYRMIDON_BOT_VOLUME_ROOT || '/tmp/myrmidon-bots';
  
  console.log(`Starting bot disk lifecycle sweep with TTL: ${config.idleTtlMs}ms`);
  
  await sweepBotVolume(botVolumeRoot, config);
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