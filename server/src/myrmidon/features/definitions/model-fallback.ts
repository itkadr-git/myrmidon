// myrmidon(FEATURES): the model fallback signal (an attention card for a bot
// whose gateway calls were quietly served by a model outside its card).
//
// Health source: the sweep's own pass. A pass that sees no attributed call is
// reported unknown, not working: the sweep also returns an empty list when the
// gateway key secret is missing, and an empty answer must not read as healthy.

import {
  FALLBACK_ENABLED_ENV,
  FALLBACK_INTERVAL_SEC_ENV,
  FALLBACK_MIN_CALLS_ENV,
  FALLBACK_THRESHOLD_PCT_ENV,
  FALLBACK_WINDOW_SEC_ENV,
  readFallbackSignalSettings,
} from "../../litellm-fallback-signal/attention.js";
import { readLitellmCostSettings } from "../../litellm-costs/litellm-costs.js";
import { entry, envIsSet, errorFields, healthOff, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const MODEL_FALLBACK_FEATURE_KEY = "model-fallback-signal";

export const modelFallbackFeature: FeatureDefinition = {
  key: MODEL_FALLBACK_FEATURE_KEY,
  name: "Model fallback signal",
  description:
    "Raises an attention card for a bot when more than a set share of its gateway calls were served by a model outside its card.",
  docs: "docs/myrmidon/SETTINGS.md#161--bot-runtime-tuning-d-model-fallback-attention-signal",
  // Environment-only settings: no panel.

  readConfig(ctx) {
    const settings = readFallbackSignalSettings(ctx.env);
    const gateway = readLitellmCostSettings(ctx.env).enabled;
    const problems: string[] = [];
    if (settings.enabled && !gateway) {
      problems.push("the gateway settings (address and key secret) are not set, so the sweep cannot read the spend log");
    }
    const src = (name: string) => (envIsSet(ctx.env, name) ? "env" : "default") as "env" | "default";
    return {
      enabled: settings.enabled,
      problems,
      entries: [
        entry("Enabled", settings.enabled, src(FALLBACK_ENABLED_ENV), FALLBACK_ENABLED_ENV),
        entry("Threshold, % of calls", settings.thresholdPct, src(FALLBACK_THRESHOLD_PCT_ENV), FALLBACK_THRESHOLD_PCT_ENV),
        entry("Minimum calls", settings.minCalls, src(FALLBACK_MIN_CALLS_ENV), FALLBACK_MIN_CALLS_ENV),
        entry("Window, s", settings.windowMs / 1000, src(FALLBACK_WINDOW_SEC_ENV), FALLBACK_WINDOW_SEC_ENV),
        entry("Sweep interval, s", settings.intervalMs / 1000, src(FALLBACK_INTERVAL_SEC_ENV), FALLBACK_INTERVAL_SEC_ENV),
      ],
    };
  },

  health(ctx, config) {
    if (!config.enabled) return healthOff("the sweep switch is off");
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    const out = ctx.outcomes(MODEL_FALLBACK_FEATURE_KEY);
    const detail = out.lastDetail ?? {};
    const calls = typeof detail.calls === "number" ? detail.calls : null;
    const signals = typeof detail.signals === "number" ? detail.signals : null;
    const base = {
      lastSuccessAt: iso(out.lastSuccessAt),
      ...errorFields(out),
      effect: { label: "agents above the threshold at the last pass", value: signals },
    };
    if (out.lastRunAt === null) {
      return makeHealth("unknown", "unknown \u2014 no sweep pass since the server started", base);
    }
    if (out.lastOk === false) {
      return makeHealth("failing", `the last sweep pass failed: ${out.lastError ?? "unknown error"}`, base);
    }
    if (calls === 0) {
      return makeHealth(
        "unknown",
        "unknown \u2014 the last pass saw no attributed gateway call (no traffic, or the gateway key secret is missing)",
        base,
      );
    }
    return makeHealth("working", `the last pass read ${calls} attributed gateway call(s)`, base);
  },
};
