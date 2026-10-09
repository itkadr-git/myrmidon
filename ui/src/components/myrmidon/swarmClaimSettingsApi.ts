// myrmidon(1.6.5 SWARM-T4, design §5.1): the "Self-organization (swarm)"
// settings — GET/PATCH /api/myrmidon/swarm-claim.
//
// The swarm parameters — the master switch, the pheromone mapping, the lease
// TTL, the per-agent ceiling, the sweep interval and the P0 preemption — are
// instance settings the server reads on every use. Saving here applies them
// without a restart: a free agent claims the top task of its caste's queue
// within one wake, and switching the swarm off frees the live leases at once.
// The environment variables remain forced overrides; `sources` says per key
// whether the UI value or the override is in force, and the panel renders
// exactly that.
import type {
  SwarmClaimSettings,
  SwarmClaimSettingsPatch,
  SwarmClaimSettingKey,
  SwarmClaimSettingSource,
} from "@paperclipai/shared";
import { api } from "@/api/client";

/** One journal entry: who changed what, and when. */
export interface SwarmClaimJournalEntry {
  at: string;
  actorType: string;
  actorId: string;
  patch: SwarmClaimSettingsPatch;
}

/**
 * 1.6.5 (OPE-6608 D): the live counters of the queues the panel configures,
 * read by GET /api/myrmidon/swarm-claim. They are what an operator watches in
 * the hour after a roll-out.
 */
export interface SwarmClaimQueueCounters {
  queuedUnassigned: number;
  claimedLastHour: number;
  cancelledLastHour: number;
}

export interface SwarmClaimSettingsView {
  settings: SwarmClaimSettings;
  sources: Record<SwarmClaimSettingKey, SwarmClaimSettingSource>;
  /** The change journal, newest first. */
  journal: SwarmClaimJournalEntry[];
  /** How many live leases a disable freed (PATCH response only). */
  releasedClaims?: number;
  /** The live queue counters (GET only; absent on a PATCH response). */
  counters?: SwarmClaimQueueCounters | null;
}

/** The one-line live status of the panel, from the GET counters; null without them. */
export function swarmClaimStatusLine(counters: SwarmClaimQueueCounters | null | undefined): string | null {
  if (!counters) return null;
  return `${counters.queuedUnassigned} unassigned task(s) waiting · ${counters.claimedLastHour} claimed in the last hour · ${counters.cancelledLastHour} cancelled in the last hour`;
}

export const swarmClaimSettingsQueryKey = ["myrmidon", "swarm-claim", "settings"] as const;

export const swarmClaimSettingsApi = {
  get: () => api.get<SwarmClaimSettingsView>("/myrmidon/swarm-claim"),
  update: (patch: SwarmClaimSettingsPatch) =>
    api.patch<SwarmClaimSettingsView>("/myrmidon/swarm-claim", patch),
};

export function describeSwarmClaimSource(source: SwarmClaimSettingSource | undefined): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Environment override";
    default:
      return "Default";
  }
}
