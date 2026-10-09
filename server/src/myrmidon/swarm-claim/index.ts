// server/src/myrmidon/swarm-claim/index.ts
//
// myrmidon(1.6-SWARM): the wiring point of the per-role task queues.
//
// app.ts mounts `swarmClaimRoutes` from here; the startup in index.ts drives
// the sweeper on its scheduler tick (the same place leases-stale-sweep and
// idle-pickup live). Everything the two parts of 1.6 share — the queue order,
// the lease states, the settings — comes from `@paperclipai/shared`, so Part B
// (the supervisor view, OPE-3609) reads the same decisions Part A enforces.

import type { Db } from "@paperclipai/db";
import {
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  resolveSwarmClaimSettings,
  type CompanyCastesReader,
} from "@paperclipai/shared";
import { logActivity as logActivityService } from "../../services/activity-log.js";
import type { instanceSettingsService } from "../../services/instance-settings.js";
import {
  matchAgent,
  matchCompany,
  matchIssue,
  type SwarmMatcherDeps,
  type SwarmMatcherPair,
  type SwarmMatcherResult,
} from "./matcher.js";
import { createSwarmClaimSweeper, type SwarmClaimSweeper } from "./sweep.js";
import {
  claimNextTaskForAgent,
  refreshLeaseForRun,
  releaseTaskAndWakeNext,
  type SwarmClaimEnqueueWakeup,
  type SwarmClaimServicePorts,
} from "./service.js";
import { swarmClaimSettingsService } from "./settings.js";
import { swarmClaimRoutes } from "./routes.js";

export * from "./domain.js";
export * from "./store.js";
export * from "./queue.js";
export * from "./service.js";
export * from "./sweep.js";
export * from "./matcher.js";
export * from "./settings.js";
export * from "./hooks.js";
export { swarmClaimRoutes };

export interface SwarmClaimPorts {
  db: Db;
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral" | "updateGeneral">;
  enqueueWakeup?: SwarmClaimEnqueueWakeup;
  env?: Record<string, string | undefined>;
}

/** Build the ports object once (app.ts / the startup both call this). */
export function swarmClaimPorts(ports: SwarmClaimPorts): SwarmClaimServicePorts {
  return {
    db: ports.db,
    settings: ports.settings,
    enqueueWakeup: ports.enqueueWakeup,
    logActivity: async (input) => {
      await logActivityService(ports.db, {
        companyId: input.companyId,
        actorType: input.actorType as "user" | "agent" | "system",
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: input.details,
      });
    },
    env: ports.env,
  };
}

/** The sweeper runtime; index.ts ticks it on the scheduler. */
export function buildSwarmClaimSweeper(ports: SwarmClaimPorts): SwarmClaimSweeper {
  return createSwarmClaimSweeper({
    ...swarmClaimPorts(ports),
    intervalMs: DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC * 1000,
  });
}

/**
 * 1.6.5 (OPE-6608, review item 1 / design §3.5): the matcher ports — the same
 * ports the app and the startup already hand around, plus the two the event
 * paths supply (the caste directory of T3 and the run admission of the moment).
 */
export interface SwarmMatcherPorts extends SwarmClaimPorts {
  /** The company caste directory (T3 port); absent, no caste is filtered. */
  castes?: CompanyCastesReader;
  /** The run admission of the host at the moment of the event; default open. */
  hostGateOpen?: () => boolean;
}

/** The board-side matcher, as an event path calls it. */
export interface SwarmMatcher {
  forCompany(companyId: string): Promise<SwarmMatcherResult>;
  forIssue(issueId: string): Promise<SwarmMatcherPair | null>;
  forAgent(agentId: string): Promise<SwarmMatcherPair | null>;
}

/**
 * The matcher for one event, or `null` when the swarm is switched off — then
 * the caller keeps whatever it did before (the release path keeps idle-pickup).
 * The switch is read per event on purpose: turning the swarm off must take
 * effect without a restart (design §5.1).
 */
export async function buildSwarmMatcher(ports: SwarmMatcherPorts): Promise<SwarmMatcher | null> {
  const general = (await ports.settings.getGeneral()) as unknown as Record<string, unknown>;
  const { settings } = resolveSwarmClaimSettings({
    stored: general.swarmClaim,
    env: ports.env ?? process.env,
  });
  if (!settings.enabled) return null;

  const servicePorts = swarmClaimPorts(ports);
  const deps: SwarmMatcherDeps = {
    db: ports.db,
    heartbeat: {
      wakeup: async (agentId, opts) => {
        const wakeup = ports.enqueueWakeup;
        if (!wakeup) return null;
        // The claim service's wake port carries the narrower field set the
        // queue wakes used; the heartbeat path behind it takes the wider shape
        // the matcher sends. The call is relayed unchanged.
        return wakeup(agentId, opts as unknown as Parameters<typeof wakeup>[1]);
      },
    },
    settings,
    hostGateOpen: ports.hostGateOpen ? ports.hostGateOpen() : true,
    now: new Date(),
    casteDirectory: ports.castes,
    logActivity: servicePorts.logActivity,
  };
  return {
    forCompany: (companyId) => matchCompany(deps, companyId),
    forIssue: (issueId) => matchIssue(deps, issueId),
    forAgent: (agentId) => matchAgent(deps, agentId),
  };
}

/**
 * The event "the agent is free" (design §3.5): the release path of the run
 * lifecycle hands the just-finished agent to the matcher, which gives it its
 * own assigned ready task first and otherwise the top ready task of its caste
 * and nest. `enabled: false` means the swarm is off and the caller's own
 * fallback is still in charge — the switch must not change that path.
 */
export async function matchFreedAgent(
  ports: SwarmMatcherPorts,
  agentId: string,
): Promise<{ enabled: boolean; pair: SwarmMatcherPair | null }> {
  const matcher = await buildSwarmMatcher(ports);
  if (!matcher) return { enabled: false, pair: null };
  return { enabled: true, pair: await matcher.forAgent(agentId) };
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