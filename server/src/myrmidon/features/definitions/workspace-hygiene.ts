// myrmidon(FEATURES): workspace quotas (per-workspace and total size signals).
//
// Health source: the sweep's last result, held in the process. With both
// quotas off the sweep measures nothing, which is a configuration choice and
// reported as off.

import { WORKSPACE_HYGIENE_ENV_KEYS, resolveWorkspaceHygieneLimits } from "@paperclipai/shared";
import { entry, healthOff, healthUnknown, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const WORKSPACE_HYGIENE_FEATURE_KEY = "workspace-hygiene";

export const workspaceHygieneFeature: FeatureDefinition = {
  key: WORKSPACE_HYGIENE_FEATURE_KEY,
  name: "Workspace quotas",
  description:
    "Measures agent workspaces and raises a clean-up signal for a workspace over its quota or a company over its total.",
  docs: "docs/myrmidon/workspace-hygiene.md",
  // The quotas are set through the API (PATCH /api/myrmidon/workspace-hygiene) or the environment.

  readConfig(ctx) {
    const { limits, sources } = resolveWorkspaceHygieneLimits({ stored: ctx.general.workspaceHygiene, env: ctx.env });
    const mb = (value: number | null) => (value === null ? "off" : `${value} MB`);
    return {
      enabled: limits.workspaceQuotaMb !== null || limits.totalQuotaMb !== null,
      entries: [
        entry("Per-workspace quota", mb(limits.workspaceQuotaMb), sources.workspaceQuotaMb, WORKSPACE_HYGIENE_ENV_KEYS.workspaceQuotaMb),
        entry("Total quota per company", mb(limits.totalQuotaMb), sources.totalQuotaMb, WORKSPACE_HYGIENE_ENV_KEYS.totalQuotaMb),
      ],
    };
  },

  health(ctx, config) {
    if (!config.enabled) return healthOff("both quotas are off");
    const state = ctx.ports.runtime.workspaceHygiene();
    if (!state) return healthUnknown("no sweep pass since the server started");
    const base = {
      lastSuccessAt: iso(new Date(state.at)),
      effect: { label: "workspaces measured at the last pass", value: state.measured },
    };
    if (state.failed > 0 && state.measured === 0) {
      return makeHealth("failing", `${state.failed} workspace(s) could not be measured and none was measured in the last pass`, base);
    }
    return makeHealth(
      "working",
      state.overQuota > 0 ? `${state.overQuota} workspace(s) over quota at the last pass` : "workspaces are measured on every sweep",
      base,
    );
  },
};
