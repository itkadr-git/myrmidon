// server/src/myrmidon/swarm-claim/index.ts
//
// myrmidon(1.6-SWARM): the wiring point of the per-role task queues.
//
// app.ts mounts `swarmClaimRoutes` from here; the startup in index.ts drives
// the sweeper on its scheduler tick (the same place leases-stale-sweep and
// idle-pickup live). Everything the two parts of 1.6 share — the queue order,
// the lease states, the settings — comes from `@paperclipai/shared`, so Part B
// (the supervisor view, OPE-3609) reads the same decisions Part A enforces.

import { DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC } from "@paperclipai/shared";
import { createSwarmClaimSweeper, type SwarmClaimSweeper } from "./sweep.js";
import {
  claimNextTaskForAgent,
  refreshLeaseForRun,
  releaseTaskAndWakeNext,
} from "./service.js";
import { swarmClaimPorts, type SwarmClaimPorts } from "./ports.js";
import { swarmClaimSettingsService } from "./settings.js";
import { swarmClaimRoutes } from "./routes.js";

export * from "./domain.js";
export * from "./store.js";
export * from "./queue.js";
export * from "./service.js";
export * from "./sweep.js";
export * from "./matcher.js";
export * from "./matcher-factory.js";
export * from "./ports.js";
export * from "./events.js";
export * from "./settings.js";
export * from "./hooks.js";
export { swarmClaimRoutes };

/** The sweeper runtime; index.ts ticks it on the scheduler. */
export function buildSwarmClaimSweeper(ports: SwarmClaimPorts): SwarmClaimSweeper {
  return createSwarmClaimSweeper({
    ...swarmClaimPorts(ports),
    intervalMs: DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC * 1000,
  });
}

/** The routes with the real ports (app.ts mounts this). */
export function swarmClaimApp(ports: SwarmClaimPorts) {
  const servicePorts = swarmClaimPorts(ports);
  return swarmClaimRoutes(
    ports.db,
    servicePorts,
    swarmClaimSettingsService(ports.db, { settings: ports.settings, env: ports.env }),
  );
}

export { claimNextTaskForAgent, refreshLeaseForRun, releaseTaskAndWakeNext };