// server/src/myrmidon/bot-containers/package-store.ts
//
// myrmidon(1.6.1-BOT-DISK-B): shared package store settings and configuration.
// Implements the common primitive for configurable bind mounts that serves both
// package cache and shared folder functionality.

import type { Db } from "@paperclipai/db";
import { readCombinedSettings, writeCombinedSettings, type CombinedBotDiskSettings } from "./bot-disk-store.js";

export interface PackageStoreSettings {
  enabled: boolean;
  packageStorePath?: string;
  sharedEnabled: boolean;
  sharedPath?: string;
}

export const DEFAULT_PACKAGE_STORE_PATH = "/var/lib/myrmidon/package-store";
export const DEFAULT_SHARED_PATH = "/var/lib/myrmidon/shared";

/**
 * Reads the package store settings from instance settings.
 */
export async function readPackageStoreSettings(db: Db): Promise<PackageStoreSettings> {
  const combinedSettings = await readCombinedSettings(db);
  
  return {
    enabled: !!combinedSettings.sharedPackageCachePath,
    packageStorePath: combinedSettings.sharedPackageCachePath,
    sharedEnabled: combinedSettings.shared?.enabled ?? false,
    sharedPath: combinedSettings.shared?.path,
  };
}

/**
 * Writes the package store settings to instance settings.
 */
export async function writePackageStoreSettings(db: Db, settings: Partial<PackageStoreSettings>): Promise<PackageStoreSettings> {
  // Read current settings to merge with new ones
  const current = await readPackageStoreSettings(db);
  const updated = { ...current, ...settings };
  
  // Prepare the combined settings object
  const combinedSettings: CombinedBotDiskSettings = {
    sharedPackageCachePath: updated.packageStorePath,
    shared: {
      enabled: updated.sharedEnabled,
      path: updated.sharedPath,
    }
  };
  
  // Update the combined settings
  await writeCombinedSettings(db, combinedSettings);
  
  return updated;
}

/**
 * Gets the default package store path based on the volume root.
 */
export function getDefaultPackageStorePath(volumeRoot: string): string {
  return `${volumeRoot}/package-store`;
}

/**
 * Gets the specific cache subdirectories within the package store.
 */
export function getPackageStoreSubdirs(): string[] {
  return [
    "pnpm",      // for pnpm store
    "pip",       // for pip cache
    "go",        // for go build cache
    "gradle",    // for gradle cache
  ];
}

/**
 * Gets environment variables that should be set in the container to point
 * to the appropriate cache directories.
 */
export function getPackageStoreEnvVars(packageStorePath: string): Record<string, string> {
  return {
    "npm_config_store_dir": `${packageStorePath}/pnpm`,
    "NPM_CONFIG_STORE_DIR": `${packageStorePath}/pnpm`,
    "GOMODCACHE": `${packageStorePath}/go`,
    "GRADLE_USER_HOME": `${packageStorePath}/gradle`,
    "PIP_CACHE_DIR": `${packageStorePath}/pip`,
  };
}
