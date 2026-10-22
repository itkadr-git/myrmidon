// myrmidon(FEATURES): budget enforcement mode (signal only, soft pause, hard
// refusal when a spend limit is crossed).
//
// The mode is read at the moment a limit is evaluated, so there is no timer
// that can die. Health is therefore the coherence of the setting with the
// policies it acts on: a stopping mode with no active limit stops nothing.

import {
  BUDGET_ENFORCEMENT_MODE_ENV,
  BUDGET_ENFORCEMENT_SETTINGS_KEY,
  budgetEnforcementStopsWork,
  resolveBudgetEnforcement,
} from "@paperclipai/shared";
import { entry, healthOff, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const BUDGET_ENFORCEMENT_FEATURE_KEY = "budget-enforcement";

export const budgetEnforcementFeature: FeatureDefinition = {
  key: BUDGET_ENFORCEMENT_FEATURE_KEY,
  name: "Budget enforcement",
  description:
    "What a crossed spend limit does: only signal the owner (default), pause the scope (soft) or refuse new runs (hard).",
  docs: "docs/myrmidon/guides/budget-enforcement.md",
  settings: { path: "/company/settings", panel: "Budget enforcement" },

  readConfig(ctx) {
    const { mode, source } = resolveBudgetEnforcement({
      stored: ctx.general[BUDGET_ENFORCEMENT_SETTINGS_KEY],
      env: ctx.env,
    });
    return {
      enabled: budgetEnforcementStopsWork(mode),
      entries: [entry("Mode", mode, source, BUDGET_ENFORCEMENT_MODE_ENV)],
    };
  },

  async health(ctx, config) {
    const { mode } = resolveBudgetEnforcement({
      stored: ctx.general[BUDGET_ENFORCEMENT_SETTINGS_KEY],
      env: ctx.env,
    });
    const stats = await ctx.ports.budget.stats(ctx.since);
    const base = {
      effect: { label: "budget incidents opened in 24 h", value: stats.incidentsSince },
    };
    if (stats.activePolicies === 0) {
      if (config.enabled) {
        return makeHealth(
          "misconfigured",
          `the mode is "${mode}" but no budget policy with a limit is active, so nothing can stop`,
          base,
        );
      }
      return healthOff("no budget policy with a limit is active");
    }
    const reason =
      mode === "signal_only"
        ? `${stats.activePolicies} active limit(s); a crossed limit only signals the owner (${stats.openIncidents} open incident(s))`
        : `${stats.activePolicies} active limit(s); a crossed limit ${mode === "soft" ? "pauses the scope" : "refuses new runs"} (${stats.openIncidents} open incident(s))`;
    return makeHealth("working", reason, base);
  },
};
