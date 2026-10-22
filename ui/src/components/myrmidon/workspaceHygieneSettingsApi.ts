// Workspace hygiene quotas (myrmidon WORKSPACE-HYGIENE part C, SETTINGS-UI A):
// GET/PATCH /api/myrmidon/workspace-hygiene.
//
// The two quotas — per workspace and per company total, in MB — are instance
// settings stored in `instance_settings.general.workspaceHygiene`. The sweep
// reads them at the top of every tick, so a change applies without a restart.
// `null` means "the cap is off", which is also the built-in default. The
// environment stays the default source for an instance that never saved a
// row; `sources` says per key whether the stored value, the environment or the
// default produced the value in force, and the panel renders exactly that.
// The GET answer also carries the sizes the sweep last measured — the panel
// never walks a disk.
import type {
  WorkspaceHygieneLimitsPatch,
  WorkspaceHygieneLimitSource,
} from "@paperclipai/shared";
import { api } from "@/api/client";

/** Mirrors server WorkspaceHygieneWorkspaceView (the server module is not importable from the UI). */
export interface WorkspaceHygieneWorkspaceRow {
  id: string;
  name: string;
  status: string;
  sizeBytes: number;
  sizeMb: number;
  measuredAt: string;
  overQuota: boolean;
  truncated: boolean;
}

/** Mirrors server WorkspaceHygieneSweepResult (the last sweep of this process). */
export interface WorkspaceHygieneSweepSummary {
  at: string;
  scanned: number;
  measured: number;
  skippedFresh: number;
  skippedUnmeasurable: number;
  failed: number;
  overQuota: number;
  signalled: number;
  totalBytes: number;
  totalSignalled: boolean;
  truncated: number;
  elapsedMs: number;
}

export interface WorkspaceHygieneSettingsView {
  quota: {
    workspaceQuotaMb: number | null;
    totalQuotaMb: number | null;
    sources: {
      workspaceQuotaMb: WorkspaceHygieneLimitSource;
      totalQuotaMb: WorkspaceHygieneLimitSource;
    };
  };
  workspaces: WorkspaceHygieneWorkspaceRow[];
  status: {
    measuredWorkspaces: number;
    overQuotaCount: number;
    totalSizeMb: number;
    lastSweepAt: string | null;
    lastSweep: WorkspaceHygieneSweepSummary | null;
  };
}

export const workspaceHygieneSettingsQueryKey = [
  "myrmidon",
  "workspace-hygiene",
  "settings",
] as const;

export const workspaceHygieneSettingsApi = {
  get: () => api.get<WorkspaceHygieneSettingsView>("/myrmidon/workspace-hygiene"),
  update: (patch: WorkspaceHygieneLimitsPatch) =>
    api.patch<WorkspaceHygieneSettingsView>("/myrmidon/workspace-hygiene", patch),
};

export function describeWorkspaceHygieneSource(
  source: WorkspaceHygieneLimitSource | undefined,
): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Environment override";
    default:
      return "Default";
  }
}
