// myrmidon(FEATURES): gateway spend collection and cost attribution.
//
// Health sources: the collection pass's own outcome (recorded on every tick),
// the collected rows in litellm_cost_events (the effect, durable across a
// restart) and the vendor ledger rows still unpriced after an hour — runs the
// gateway billed that the board still shows as $0.

import { entry, envIsSet, errorFields, healthOff, iso, latestOf, makeHealth } from "../health.js";
import {
  LITELLM_BASE_URL_ENV,
  LITELLM_FIRST_LOOKBACK_DAYS_ENV,
  LITELLM_KEY_SECRET_ENV,
  LITELLM_SWEEP_INTERVAL_ENV,
  readLitellmCostSettings,
} from "../../litellm-costs/litellm-costs.js";
import { COST_ATTRIBUTION_FEATURE_KEY } from "../reporters.js";
import type { FeatureDefinition } from "../types.js";

export const costAttributionFeature: FeatureDefinition = {
  key: COST_ATTRIBUTION_FEATURE_KEY,
  name: "Cost attribution sweep",
  description:
    "Collects the LLM gateway's spend log, attributes it to agents and runs by the bot's key, and fills the prices into the cost ledger.",
  docs: "docs/myrmidon/SETTINGS.md",
  // Deployment settings only: no panel.

  readConfig(ctx) {
    const settings = readLitellmCostSettings(ctx.env);
    const urlSet = envIsSet(ctx.env, LITELLM_BASE_URL_ENV);
    const secretSet = envIsSet(ctx.env, LITELLM_KEY_SECRET_ENV);
    const problems: string[] = [];
    if (urlSet !== secretSet) {
      problems.push(
        `${urlSet ? LITELLM_KEY_SECRET_ENV : LITELLM_BASE_URL_ENV} is not set: collection needs both and stays off until they are`,
      );
    }
    return {
      enabled: settings.enabled,
      problems,
      entries: [
        // The gateway address is not shown: only whether it is set.
        entry("Gateway address", urlSet ? "set" : null, urlSet ? "env" : "default", LITELLM_BASE_URL_ENV),
        entry("Key secret name", settings.keySecret, secretSet ? "env" : "default", LITELLM_KEY_SECRET_ENV),
        entry(
          "Pass interval, s",
          settings.intervalMs / 1000,
          envIsSet(ctx.env, LITELLM_SWEEP_INTERVAL_ENV) ? "env" : "default",
          LITELLM_SWEEP_INTERVAL_ENV,
        ),
        entry(
          "First pass lookback, days",
          settings.firstLookbackDays,
          envIsSet(ctx.env, LITELLM_FIRST_LOOKBACK_DAYS_ENV) ? "env" : "default",
          LITELLM_FIRST_LOOKBACK_DAYS_ENV,
        ),
      ],
    };
  },

  async health(ctx, config) {
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    if (!config.enabled) return healthOff("the gateway address and key secret are not set");
    const stats = await ctx.ports.costs.stats(ctx.since);
    const out = ctx.outcomes(COST_ATTRIBUTION_FEATURE_KEY);
    const base = {
      lastSuccessAt: iso(latestOf(out.lastSuccessAt, stats.lastCollectedAt)),
      ...errorFields(out),
      effect: { label: "gateway spend rows attributed in 24 h", value: stats.collected },
    };
    if (out.lastOk === false) {
      return makeHealth("failing", `the last collection pass failed: ${out.lastError ?? "unknown error"}`, base);
    }
    if (stats.unpricedStale > 0 && stats.collected === 0) {
      return makeHealth(
        "failing",
        `${stats.unpricedStale} run(s) are still unpriced after an hour and nothing was collected in 24 h`,
        base,
      );
    }
    if (out.lastRunAt === null && stats.collected === 0) {
      return makeHealth("unknown", "unknown — no collection pass since the server started and no row collected in 24 h", base);
    }
    return makeHealth(
      "working",
      stats.collected > 0
        ? `${stats.collected} gateway spend row(s) attributed in 24 h`
        : "collection passes run; the gateway reported no spend in 24 h",
      base,
    );
  },
};
