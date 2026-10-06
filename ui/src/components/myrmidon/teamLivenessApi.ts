// Team liveness (myrmidon TEAM-LIVENESS-SETTINGS): GET/PATCH /api/myrmidon/team-liveness.
//
// The knobs of the three automatic behaviours — auto-resume, progress-based run
// liveness and wake-on-ready-work. The view reports the effective values, the
// keys the instance saved and, per key, whether the stored value, the server
// environment or the built-in default is in force; PATCH saves what the
// operator changed and the three sweeps pick it up on their next pass, no
// restart.
import type {
  TeamLivenessKey,
  TeamLivenessSettings,
  TeamLivenessSettingsPatch,
  TeamLivenessSource,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export interface TeamLivenessView {
  settings: TeamLivenessSettings;
  stored: TeamLivenessSettingsPatch;
  sources: Record<TeamLivenessKey, TeamLivenessSource>;
  defaults: TeamLivenessSettings;
  bounds: Record<string, { min: number; max: number; default: number }>;
}

export const teamLivenessQueryKey = ["myrmidon", "team-liveness"] as const;

export const teamLivenessApi = {
  get: () => api.get<TeamLivenessView>("/myrmidon/team-liveness"),
  update: (patch: TeamLivenessSettingsPatch) =>
    api.patch<TeamLivenessView>("/myrmidon/team-liveness", patch),
  // myrmidon(TEAM-LIVENESS-METRICS): the 24-hour counters of the health card.
  metrics: (companyId: string) =>
    api.get<TeamLivenessMetrics>(`/myrmidon/team-liveness/metrics?companyId=${encodeURIComponent(companyId)}`),
};

/** The 24-hour counters of one company, as the server counts them. */
export interface TeamLivenessMetrics {
  companyId: string;
  windowHours: number;
  from: string;
  to: string;
  autoResumes: number;
  autoResumeExhaustions: number;
  wakes: number;
  stalledRuns: number;
}

export function teamLivenessMetricsKey(companyId: string) {
  return ["myrmidon", "team-liveness", "metrics", companyId] as const;
}

/** The layer a field's value comes from, in the operator's words. */
export function describeTeamLivenessSource(source: TeamLivenessSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "From the server environment";
    default:
      return "Default";
  }
}