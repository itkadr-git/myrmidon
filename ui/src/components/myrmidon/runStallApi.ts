// Run stall detection settings (myrmidon RUN-STALL-SETTINGS, 1.6.5, OPE-5087):
// GET/PATCH /api/myrmidon/run-stall.
//
// The values drive the progress-based run liveness sweep: whether it runs,
// how long a run may go without recorded progress before it is interrupted,
// the minimum spacing between two scan passes and how many runs one pass
// inspects. PATCH saves them to the instance settings and they apply
// immediately, without restarting the server.
import type { RunStallPatch, RunStallSource, RunStallKey, RunStallValues } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface RunStallView {
  settings: RunStallValues;
  sources: Record<RunStallKey, RunStallSource>;
}

export const runStallQueryKey = ["myrmidon", "run-stall"] as const;

export const runStallApi = {
  get: () => api.get<RunStallView>("/myrmidon/run-stall"),
  update: (patch: RunStallPatch) => api.patch<RunStallView>("/myrmidon/run-stall", patch),
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
