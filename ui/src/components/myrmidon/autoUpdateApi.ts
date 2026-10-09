// myrmidon(1.7-AUTO-UPDATE-B): API client of the update policy screen —
// GET/PATCH /api/myrmidon/auto-update plus its approvals
// (server/src/myrmidon/deploy-jobs/auto-update-routes.ts).
//
// `settings` is what the scheduler executes (env override included), `stored`
// is the row the screen edits, and `sources` says where each value came from —
// the panel shows that next to every knob.
import { api } from "@/api/client";

export type AutoUpdateSource = "ui" | "env" | "default";
export type AutoUpdateMode = "manual" | "auto_release";

export interface AutoUpdateWindow {
  /** Weekday numbers, 0 = Sunday … 6 = Saturday; empty means "no window". */
  days: number[];
  /** Minutes from midnight UTC. */
  fromMinute: number;
  toMinute: number;
}

export interface AutoUpdateCanary {
  enabled: boolean;
  sharePercent: number;
  minBots: number;
  maxBots: number;
  healthSettleSec: number;
}

export interface AutoUpdateApproval {
  tag: string;
  digest: string;
  version: string | null;
  approvedBy: { actorType: string; actorId: string };
  approvedAt: string;
  /** The deploy this approval started, if any. */
  jobId: string | null;
}

export interface AutoUpdateSettings {
  mode: AutoUpdateMode;
  window: AutoUpdateWindow;
  canary: AutoUpdateCanary;
  approvals: AutoUpdateApproval[];
}

export interface AutoUpdateWindowState {
  open: boolean;
  opensAt: string | null;
  closesAt: string | null;
  reason: string;
}

export interface AutoUpdateView {
  /** The stored row: what an edit changes. */
  stored: AutoUpdateSettings;
  /** The policy in force: env override already applied. */
  settings: AutoUpdateSettings;
  sources: { mode: AutoUpdateSource; window: AutoUpdateSource; canary: AutoUpdateSource };
  /** The knobs the environment forces, so the screen cannot change them. */
  overridden: string[];
  window: AutoUpdateWindowState;
  start: { allowed: boolean; reason: string; candidate: AutoUpdateApproval | null };
  defaults: AutoUpdateSettings;
}

export interface AutoUpdatePatch {
  mode?: AutoUpdateMode;
  window?: AutoUpdateWindow;
  canary?: AutoUpdateCanary;
}

export const autoUpdateQueryKey = ["myrmidon", "auto-update"] as const;

export const autoUpdateApi = {
  get: () => api.get<AutoUpdateView>("/myrmidon/auto-update"),
  patch: (patch: AutoUpdatePatch) => api.patch<AutoUpdateView>("/myrmidon/auto-update", patch),
  approve: (input: { tag: string; digest: string; version?: string }) =>
    api.post<AutoUpdateView>("/myrmidon/auto-update/approvals", input),
  withdraw: (tag: string) => api.delete<AutoUpdateView>(`/myrmidon/auto-update/approvals/${encodeURIComponent(tag)}`),
};