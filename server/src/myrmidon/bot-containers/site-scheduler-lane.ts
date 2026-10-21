// server/src/myrmidon/bot-containers/site-scheduler-lane.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): 30s background sweep for the site-scheduler.
//
// Every tick reads the bot cards (agent id = bot key), the company's sites and affinity rules,
// and runs the pure scheduler over them. What it does with the verdict:
//
//  - affinity says another site than the one the bot is on  -> the bot is MOVED with the fleet
//    move state machine (stop, snapshot, restore, ...), never by rewriting container.host: a
//    card edit alone would start an empty bot on the new site and strand its data;
//  - the affinity site has no room                          -> the bot stays where it is, its
//    card is marked placementStatus=pending_placement and a warning is logged (never a silent
//    fallback to the local host);
//  - capacity-only verdicts (no affinity) and pinned bots   -> nothing happens. Capacity placement
//    is for choosing a site for a bot that has none; a running bot is not shuffled for balance.
//
// Moves are paced: at most one at a time, a bot with an unfinished move gets that move resumed,
// and a bot whose last move failed is left alone for RETRY_AFTER_FAILURE_MS (a failed move was
// rolled back and needs a human look, not a retry every 30 seconds).

import { laneInterval } from "../monitoring/board-load/lanes.js";
import {
  scheduleSitePlacements,
  type AgentPlacementInput,
  type FleetSiteInfo,
  type AffinityRule,
  type SchedulerResult,
} from "./site-scheduler.js";
import { cardFleetHost } from "./fleetd-hosts.js";
import { botKeyForAgent } from "./agent-config.js";
import type { FleetMoveRecord } from "./fleet-move-service.js";

export interface ScheduledAgentCard {
  /** The agent id, which is also the bot key. */
  id: string;
  companyId: string;
  adapterConfig: Record<string, unknown>;
}

export interface SiteSchedulerLaneDeps {
  listAgents(): Promise<ScheduledAgentCard[]>;
  listSites(companyId: string): Promise<FleetSiteInfo[]>;
  listAffinityRules(companyId: string): Promise<AffinityRule[]>;
  /** Starts or resumes the move of a bot; resolves when the move has ended. */
  requestMove(params: { companyId: string; botKey: string; dstSite: string }): Promise<FleetMoveRecord>;
  getLatestMove(companyId: string, botKey: string): Promise<FleetMoveRecord | null>;
  /** Replaces the card's container block, leaving the rest of the card as it is now (not as listed). */
  saveContainerConfig(agentId: string, container: Record<string, unknown>): Promise<void>;
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  intervalMs?: number;
  preemptionEnabled?: boolean;
  maxConcurrentMoves?: number;
  retryAfterFailureMs?: number;
  now?: () => number;
}

export const SITE_SCHEDULER_INTERVAL_MS = 30_000;
export const RETRY_AFTER_FAILURE_MS = 15 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyResult(): SchedulerResult {
  return { decisions: new Map(), siteAllocations: new Map(), pendingPlacementQueue: [], alerts: [] };
}

/** The bot's placement input from its card. `priority`, `projectId` and `labels` are optional
 *  scheduling hints on the container block; a card without them is a medium-priority bot. */
function placementInput(card: ScheduledAgentCard): AgentPlacementInput | null {
  const botKey = botKeyForAgent(card.id);
  const container = isRecord(card.adapterConfig.container) ? card.adapterConfig.container : null;
  if (!botKey || !container || container.enabled !== true) return null;

  const memoryMb = typeof container.memoryMb === "number" && container.memoryMb > 0 ? container.memoryMb : 1024;
  const cpus = typeof container.cpus === "number" && container.cpus > 0 ? container.cpus : 1;
  const pidsLimit = typeof container.pidsLimit === "number" ? container.pidsLimit : undefined;

  let currentHost: string | null = null;
  try {
    currentHost = cardFleetHost(card.adapterConfig);
  } catch {
    return null; // an invalid host on the card is the reconciler's error to report, not ours to move
  }

  return {
    botKey,
    agentId: card.id,
    companyId: card.companyId,
    projectId: typeof container.projectId === "string" ? container.projectId : null,
    priority: typeof container.priority === "string" ? container.priority : null,
    currentHost,
    hostPinned: container.hostPinned === true,
    spec: { memoryMb, cpus, pidsLimit },
    labels: isRecord(container.labels) ? (container.labels as Record<string, string>) : undefined,
  };
}

function isUnfinished(move: FleetMoveRecord | null): move is FleetMoveRecord {
  return move !== null && move.phase !== "done" && move.phase !== "failed";
}

function lastActivityMs(move: FleetMoveRecord): number {
  const last = move.phaseLog[move.phaseLog.length - 1];
  const at = last ? Date.parse(last.at) : NaN;
  return Number.isFinite(at) ? at : move.startedAt.getTime();
}

export function startSiteSchedulerLane(deps: SiteSchedulerLaneDeps): {
  stop: () => void;
  tick: () => Promise<SchedulerResult>;
} {
  const intervalMs = deps.intervalMs ?? SITE_SCHEDULER_INTERVAL_MS;
  const maxConcurrentMoves = deps.maxConcurrentMoves ?? 1;
  const retryAfterFailureMs = deps.retryAfterFailureMs ?? RETRY_AFTER_FAILURE_MS;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log;
  let running = false;
  const movesInFlight = new Set<string>();

  function launchMove(companyId: string, botKey: string, dstSite: string, why: string): void {
    movesInFlight.add(botKey);
    log?.info({ botKey, dstSite, why }, "site-scheduler: starting bot move");
    void deps
      .requestMove({ companyId, botKey, dstSite })
      .then((move) => {
        const fields = { botKey, dstSite, phase: move.phase, error: move.error ?? undefined };
        if (move.phase === "done") log?.info(fields, "site-scheduler: bot move finished");
        else log?.error(fields, "site-scheduler: bot move did not finish");
      })
      .catch((err: unknown) => {
        log?.error({ botKey, dstSite, err }, "site-scheduler: bot move request failed");
      })
      .finally(() => {
        movesInFlight.delete(botKey);
      });
  }

  async function tick(): Promise<SchedulerResult> {
    if (running) return emptyResult();
    running = true;
    try {
      const rawAgents = await deps.listAgents();
      if (rawAgents.length === 0) return emptyResult();

      const byCompany = new Map<string, ScheduledAgentCard[]>();
      for (const ag of rawAgents) {
        const list = byCompany.get(ag.companyId) ?? [];
        list.push(ag);
        byCompany.set(ag.companyId, list);
      }

      const allDecisions: SchedulerResult["decisions"] = new Map();
      const allAllocations: SchedulerResult["siteAllocations"] = new Map();
      const allPending: string[] = [];
      const allAlerts: SchedulerResult["alerts"] = [];

      for (const [companyId, companyAgents] of byCompany.entries()) {
        const sites = await deps.listSites(companyId);
        const affinityRules = await deps.listAffinityRules(companyId);

        const inputs: AgentPlacementInput[] = [];
        const cards = new Map<string, ScheduledAgentCard>();
        for (const card of companyAgents) {
          const input = placementInput(card);
          if (!input) continue;
          inputs.push(input);
          cards.set(input.botKey, card);
        }

        const result = scheduleSitePlacements(inputs, sites, affinityRules, {
          preemptionEnabled: deps.preemptionEnabled,
        });
        for (const [k, v] of result.decisions.entries()) allDecisions.set(k, v);
        for (const [k, v] of result.siteAllocations.entries()) allAllocations.set(k, v);
        allPending.push(...result.pendingPlacementQueue);
        allAlerts.push(...result.alerts);

        const inputByBot = new Map(inputs.map((i) => [i.botKey, i] as const));

        for (const decision of result.decisions.values()) {
          const card = cards.get(decision.botKey);
          const input = inputByBot.get(decision.botKey);
          if (!card || !input || input.hostPinned) continue;
          const container = isRecord(card.adapterConfig.container) ? card.adapterConfig.container : {};

          if (decision.status === "placed") {
            // A bot that is placed as the scheduler wants it has no pending mark any more.
            if (container.placementStatus !== undefined && decision.targetHost === input.currentHost) {
              const next = { ...container };
              delete next.placementStatus;
              delete next.placementError;
              await deps.saveContainerConfig(card.id, next);
            }
            if (decision.reason !== "affinity" || decision.targetHost === null || decision.targetHost === input.currentHost) {
              continue;
            }

            // Affinity wants the bot on another site: a move, paced and never overlapping itself.
            const latest = await deps.getLatestMove(companyId, decision.botKey);
            if (movesInFlight.has(decision.botKey)) continue;
            if (isUnfinished(latest)) {
              // Left unfinished by a restart: resume it (the move continues after its last phase).
              if (movesInFlight.size < maxConcurrentMoves) {
                launchMove(companyId, decision.botKey, latest.dstSite, "resume unfinished move");
              }
              continue;
            }
            if (latest?.phase === "failed" && now() - lastActivityMs(latest) < retryAfterFailureMs) continue;
            if (movesInFlight.size >= maxConcurrentMoves) continue;
            launchMove(companyId, decision.botKey, decision.targetHost, `affinity: ${decision.reason}`);
          } else if (decision.status === "pending_placement" && decision.matchedAffinity) {
            if (container.placementStatus !== "pending_placement") {
              const message = decision.alert ?? "Waiting for site capacity";
              log?.warn(
                { botKey: decision.botKey, reason: decision.reason, error: message },
                "site-scheduler: bot queued in pending placement",
              );
              await deps.saveContainerConfig(card.id, {
                ...container,
                placementStatus: "pending_placement",
                placementError: message,
              });
            }
          }
        }
      }

      return {
        decisions: allDecisions,
        siteAllocations: allAllocations,
        pendingPlacementQueue: allPending,
        alerts: allAlerts,
      };
    } finally {
      running = false;
    }
  }

  const timer = laneInterval(
    "bot_reconcile",
    intervalMs,
    () => tick(),
    (err) => log?.error({ err }, "site-scheduler: sweep error"),
  );
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
