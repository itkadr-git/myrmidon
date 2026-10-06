// GET/PATCH /api/myrmidon/tool-policy-cache (myrmidon DB-PERF-C-P4).
//
// The instance setting behind the tool gateway's policy cache: how long a
// snapshot of the company's bindings, profiles, profile entries and enabled
// policies may be served before it is read again, stored in
// `instance_settings.general.toolPolicyCache`. The cache re-reads the row on
// every access, so a change applies without a restart; `ttlMs: 0` switches the
// cache off and the gateway reads everything fresh. GET is open to board
// members; PATCH is instance-admin only, like the rest of the instance
// settings. There is no UI panel for this setting in this part — the API is the
// way to change it.

import { Router } from "express";
import {
  applyToolPolicyCachePatch,
  normalizeToolPolicyCacheSettings,
  patchToolPolicyCacheSettingsSchema,
  resolveToolPolicyCacheTtlMs,
  TOOL_POLICY_CACHE_DEFAULT_TTL_MS,
  TOOL_POLICY_CACHE_MAX_TTL_MS,
  TOOL_POLICY_CACHE_MIN_TTL_MS,
  type PatchToolPolicyCacheSettings,
  type ToolPolicyCacheSettings,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { readStoredToolPolicyCacheSettings } from "./settings.js";

export interface ToolPolicyCacheSettingsView {
  /** What is stored in the instance setting (an empty object = the default). */
  settings: ToolPolicyCacheSettings;
  /** What is in force now. */
  effective: {
    /** Milliseconds a cached snapshot is served; 0 means the cache is off. */
    ttlMs: number;
    cacheEnabled: boolean;
    defaultTtlMs: number;
    minTtlMs: number;
    maxTtlMs: number;
    /** Companies currently held by this process's cache. */
    cachedCompanies: number;
    /** Snapshot loads that reached the database since the process started. */
    loads: number;
    hits: number;
    misses: number;
  };
}

export interface ToolPolicyCacheSettingsDeps {
  getGeneral(): Promise<{ toolPolicyCache?: unknown }>;
  updateGeneral(patch: { toolPolicyCache: ToolPolicyCacheSettings }): Promise<unknown>;
  /** Live cache counters of this process; omitted in the pure service tests. */
  stats?: () => { companies: number; loads: number; hits: number; misses: number };
}

export function toolPolicyCacheSettingsService(deps: ToolPolicyCacheSettingsDeps) {
  const view = (settings: ToolPolicyCacheSettings): ToolPolicyCacheSettingsView => {
    const ttlMs = resolveToolPolicyCacheTtlMs(settings);
    const stats = deps.stats?.() ?? { companies: 0, loads: 0, hits: 0, misses: 0 };
    return {
      settings,
      effective: {
        ttlMs,
        cacheEnabled: ttlMs > 0,
        defaultTtlMs: TOOL_POLICY_CACHE_DEFAULT_TTL_MS,
        minTtlMs: TOOL_POLICY_CACHE_MIN_TTL_MS,
        maxTtlMs: TOOL_POLICY_CACHE_MAX_TTL_MS,
        cachedCompanies: stats.companies,
        loads: stats.loads,
        hits: stats.hits,
        misses: stats.misses,
      },
    };
  };

  return {
    async read(): Promise<ToolPolicyCacheSettingsView> {
      const general = await deps.getGeneral();
      return view(readStoredToolPolicyCacheSettings(general));
    },
    async update(patch: PatchToolPolicyCacheSettings): Promise<ToolPolicyCacheSettingsView> {
      const general = await deps.getGeneral();
      const next = applyToolPolicyCachePatch(
        normalizeToolPolicyCacheSettings(general.toolPolicyCache),
        patch,
      );
      await deps.updateGeneral({ toolPolicyCache: next });
      return view(next);
    },
  };
}

export function toolPolicyCacheSettingsRoutes(service: ReturnType<typeof toolPolicyCacheSettingsService>) {
  const router = Router();

  router.get("/myrmidon/tool-policy-cache", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch(
    "/myrmidon/tool-policy-cache",
    validate(patchToolPolicyCacheSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.update(req.body as PatchToolPolicyCacheSettings));
    },
  );

  return router;
}