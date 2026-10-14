// Tool gateway policy cache (myrmidon DB-PERF-C-P4): GET/PATCH /api/myrmidon/tool-policy-cache.
//
// How long the gateway may serve one snapshot of a company's tool policies,
// profiles, bindings and profile entries before reading them again. The server
// re-reads the setting on every cache access, so a saved value applies to the
// next gateway call without a restart; 0 switches the cache off.
import type { PatchToolPolicyCacheSettings, ToolPolicyCacheSettings } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface ToolPolicyCacheView {
  /** What is stored (an empty object means the default). */
  settings: ToolPolicyCacheSettings;
  effective: {
    /** Milliseconds a snapshot is served; 0 means the cache is off. */
    ttlMs: number;
    cacheEnabled: boolean;
    defaultTtlMs: number;
    minTtlMs: number;
    maxTtlMs: number;
    cachedCompanies: number;
    loads: number;
    hits: number;
    misses: number;
  };
}

export const toolPolicyCacheQueryKey = ["myrmidon", "tool-policy-cache"] as const;

export const toolPolicyCacheApi = {
  get: () => api.get<ToolPolicyCacheView>("/myrmidon/tool-policy-cache"),
  update: (patch: PatchToolPolicyCacheSettings) =>
    api.patch<ToolPolicyCacheView>("/myrmidon/tool-policy-cache", patch),
};
