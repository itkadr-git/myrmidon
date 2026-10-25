// server/src/myrmidon/bot-containers/fleet-memory-sync-wiring.ts
//
// myrmidon(1.6.6 C-MEM): builds the memory sync service from the environment. Opt-in, like the
// other site lanes: without MYRMIDON_FLEET_MEMORY_SYNC=1 and a hindsight to import into
// (MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL) nothing is built and nothing syncs.

import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { fleetMemorySyncStore } from "./fleet-memory-sync-store.js";
import { createFleetMemorySyncService, FLEET_MEMORY_REPLICA_BANK, type FleetMemorySyncService } from "./fleet-memory-sync.js";
import { fleetMemoryImporterFromEnv, FLEET_MEMORY_REPLICA_BANK_ENV } from "./fleet-memory-hindsight.js";

export const FLEET_MEMORY_SYNC_ENV = "MYRMIDON_FLEET_MEMORY_SYNC";
export const FLEET_MEMORY_SYNC_HOUR_ENV = "MYRMIDON_FLEET_MEMORY_SYNC_HOUR_UTC";

export function isFleetMemorySyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FLEET_MEMORY_SYNC_ENV] === "1";
}

/** The UTC hour after which the nightly sync is due; undefined (the lane's default) when unset or invalid. */
export function fleetMemorySyncHourFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[FLEET_MEMORY_SYNC_HOUR_ENV]?.trim();
  if (!raw || !/^\d{1,2}$/.test(raw)) return undefined;
  const hour = Number(raw);
  return hour >= 0 && hour <= 23 ? hour : undefined;
}

export function fleetMemorySyncFromEnv(
  db: Db,
  env: NodeJS.ProcessEnv,
  exportArchive: (site: { companyId: string; name: string }, botKey: string) => Promise<Buffer>,
): FleetMemorySyncService | null {
  if (!isFleetMemorySyncEnabled(env)) return null;
  const importArchive = fleetMemoryImporterFromEnv(env);
  if (!importArchive) {
    logger.warn("fleet memory sync is on but MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL is not set: nothing will sync");
    return null;
  }
  return createFleetMemorySyncService({
    store: fleetMemorySyncStore(db),
    targetBank: env[FLEET_MEMORY_REPLICA_BANK_ENV]?.trim() || FLEET_MEMORY_REPLICA_BANK,
    exportArchive,
    importArchive,
    log: logger,
  });
}
