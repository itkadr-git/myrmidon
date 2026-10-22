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
//
// myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894): every user-visible string
// here is an i18n key of the fork catalog (en/ru) — the panel renders
// `t(key)`. The task-cooldown block of the panel reads and writes
// `general.swarm`, the one cooling rule the wake-task guard actually applies
// (F-26); the dead `pheromone.cooldown*` fields are retired from the schema.
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

/**
 * The one-line live status of the panel, from the GET counters; null without
 * them. myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894): the line goes through
 * the fork i18n catalog when a translator (the panel's `t`) is given; without
 * one it keeps the English wording, so callers outside a React tree still get
 * a readable line.
 */
export function swarmClaimStatusLine(
  counters: SwarmClaimQueueCounters | null | undefined,
  translate?: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!counters) return null;
  if (translate) {
    return translate("swarmClaim.statusLine", {
      queued: counters.queuedUnassigned,
      claimed: counters.claimedLastHour,
      cancelled: counters.cancelledLastHour,
    });
  }
  return `${counters.queuedUnassigned} unassigned task(s) waiting · ${counters.claimedLastHour} claimed in the last hour · ${counters.cancelledLastHour} cancelled in the last hour`;
}

export const swarmClaimSettingsQueryKey = ["myrmidon", "swarm-claim", "settings"] as const;

export const swarmClaimSettingsApi = {
  get: () => api.get<SwarmClaimSettingsView>("/myrmidon/swarm-claim"),
  update: (patch: SwarmClaimSettingsPatch) =>
    api.patch<SwarmClaimSettingsView>("/myrmidon/swarm-claim", patch),
};

/**
 * myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894): the i18n key describing
 * where the effective value of a field came from; the panel renders
 * `t(describeSwarmClaimSource(…))`.
 */
export function describeSwarmClaimSource(source: SwarmClaimSettingSource | undefined): string {
  switch (source) {
    case "settings":
      return "swarmClaim.sourceSaved";
    case "env":
      return "swarmClaim.sourceEnv";
    default:
      return "swarmClaim.sourceDefault";
  }
}
