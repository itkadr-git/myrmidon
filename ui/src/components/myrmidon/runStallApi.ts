// Run stall detection settings (myrmidon RUN-STALL-SETTINGS, 1.6.5):
// GET/PATCH /api/myrmidon/run-stall.
//
// The values drive the progress-based run liveness sweep: whether it runs,
// how long a run may go without recorded progress before it is interrupted,
// the minimum spacing between two scan passes and how many runs one pass
// inspects. PATCH saves them to the instance settings and they apply
// immediately, without restarting the server.
import type { RunStallPatch, RunStallSource, RunStallKey, RunStallValues } from "@paperclipai/shared";

/** The two keys this panel edits; `enabled` and the threshold belong to team-liveness. */
export type RunStallEditablePatch = Pick<RunStallPatch, "checkIntervalSec" | "pageSize">;
import { api } from "@/api/client";

export interface RunStallView {
  settings: RunStallValues;
  sources: Record<RunStallKey, RunStallSource>;
  /** Keys decided by the team-liveness settings; shown read-only here. */
  managedBy?: { keys: readonly string[]; owner: "team-liveness"; path: string };
}

export const runStallQueryKey = ["myrmidon", "run-stall"] as const;

export const runStallApi = {
  get: () => api.get<RunStallView>("/myrmidon/run-stall"),
  update: (patch: RunStallEditablePatch) => api.patch<RunStallView>("/myrmidon/run-stall", patch),
};

export function describeRunStallSource(source: RunStallSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "From the server environment";
    default:
      return "Default";
  }
}
