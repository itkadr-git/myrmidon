// server/src/myrmidon/swarm-claim/matcher-factory.ts
//
// myrmidon(1.6.5 OPE-6608): the board-side matcher, built for one event. Split
// out of index.ts so the event paths (issue hooks, resume, the claim API, the
// supervisor rebalance) can build it without importing the wiring point.

import { readStoredSwarmSettings, resolveSwarmClaimSettings } from "@paperclipai/shared";
import { currentHostCpuGate, currentHostMemoryGate } from "../run-admission.js";
import {
  matchAgent,
  matchCompany,
  matchIssue,
  type SwarmFreedAgentOptions,
  type SwarmMatcherDeps,
  type SwarmMatcherPair,
  type SwarmMatcherResult,
} from "./matcher.js";
import { swarmClaimPorts, type SwarmClaimPorts } from "./ports.js";

/**
 * 1.6.5 (OPE-6608, review item 1 / design §3.5): the matcher ports — the same
 * ports the app and the startup already hand around, plus the two the event
 * paths supply (the caste directory of T3 and the run admission of the moment).
 */
export interface SwarmMatcherPorts extends Omit<SwarmClaimPorts, "settings"> {
  /** Only the read is used: the matcher never writes settings. */
  settings: Pick<SwarmClaimPorts["settings"], "getGeneral">;
  /** The clock of the pass; default is the moment of the event. */
  now?: () => Date;
  /** The run admission of the host at the moment of the event; default the real gates of the run admission. */
  hostGateOpen?: () => boolean;
}

/**
 * True while the host's run admission lets a run start: neither the memory floor
 * nor the CPU ceiling is closed. An unreadable host ("unknown") does not block,
 * exactly as it does not for the run starts themselves (design §3.4 п.5).
 */
export function hostRunAdmissionOpen(): boolean {
  return currentHostMemoryGate().state !== "closed" && currentHostCpuGate().state !== "closed";
}

/** The board-side matcher, as an event path calls it. */
export interface SwarmMatcher {
  forCompany(companyId: string): Promise<SwarmMatcherResult>;
  forIssue(issueId: string): Promise<SwarmMatcherPair | null>;
  /**
   * `explicit` is the agent's own pull ("take the next task", the claim API):
   * the agent is running by definition, so its live run does not make it busy,
   * and nobody is woken — it asked, it is already awake.
   */
  forAgent(
    agentId: string,
    opts?: SwarmFreedAgentOptions & { explicit?: boolean },
  ): Promise<SwarmMatcherPair | null>;
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
    stored: readStoredSwarmSettings(general),
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
    // The real run admission unless a caller supplies its own reading: a matcher
    // that assumed "open" paired tasks the host could not start (review item 6).
    hostGateOpen: (ports.hostGateOpen ?? hostRunAdmissionOpen)(),
    now: ports.now ? ports.now() : new Date(),
    casteDirectory: ports.castes,
    logActivity: servicePorts.logActivity,
  };
  return {
    forCompany: (companyId) => matchCompany(deps, companyId),
    forIssue: (issueId) => matchIssue(deps, issueId),
    forAgent: (agentId, opts) => matchAgent(deps, agentId, opts),
  };
}

/**
 * The event "the agent is free" (design §3.5): the release path of the run
 * lifecycle hands the just-finished agent to the matcher, which gives it its
 * own assigned ready task first and otherwise the top ready task of its caste
 * and nest. `enabled: false` means the swarm is off and the caller's own
 * fallback is still in charge — the switch must not change that path.
 * `options` carries what the release path knows (the task that just ended, the
 * idle-pickup switch, the company wake allowance) so the loop guards of idle
 * pickup hold on this path too (review item 1).
 */
export async function matchFreedAgent(
  ports: SwarmMatcherPorts,
  agentId: string,
  options: SwarmFreedAgentOptions = {},
): Promise<{ enabled: boolean; pair: SwarmMatcherPair | null }> {
  const matcher = await buildSwarmMatcher(ports);
  if (!matcher) return { enabled: false, pair: null };
  return { enabled: true, pair: await matcher.forAgent(agentId, options) };
}
