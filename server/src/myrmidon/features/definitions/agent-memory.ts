// myrmidon(FEATURES): the agent memory card (the Memory tab on an agent).
//
// Health source: every call the card makes to the shared memory service is
// recorded (success or error). The configuration is checked as a pair — the
// address and the key secret must both be set — because one without the other
// leaves the tab "not enabled" with nothing pointing at the missing half.

import {
  MEMORY_HINDSIGHT_API_URL_ENV,
  MEMORY_HINDSIGHT_KEY_SECRET_ENV,
  readHttpUrlSetting,
} from "../../agent-memory/settings.js";
import { entry, envIsSet, errorFields, healthOff, iso, makeHealth } from "../health.js";
import { AGENT_MEMORY_FEATURE_KEY } from "../reporters.js";
import type { FeatureDefinition } from "../types.js";

export const agentMemoryFeature: FeatureDefinition = {
  key: AGENT_MEMORY_FEATURE_KEY,
  name: "Agent memory card",
  description:
    "The Memory tab of an agent: lists the memories of the bank the agent really uses, with invalidate, clear and export.",
  docs: "docs/myrmidon/guides/agent-memory-card.md",
  // No settings panel: the address and the secret name are deployment settings.

  readConfig(ctx) {
    const urlSet = envIsSet(ctx.env, MEMORY_HINDSIGHT_API_URL_ENV);
    const urlValid = readHttpUrlSetting(ctx.env[MEMORY_HINDSIGHT_API_URL_ENV]) !== null;
    const secretSet = envIsSet(ctx.env, MEMORY_HINDSIGHT_KEY_SECRET_ENV);
    const problems: string[] = [];
    if (urlSet && !urlValid) problems.push(`${MEMORY_HINDSIGHT_API_URL_ENV} is not an http(s) address`);
    if (urlSet !== secretSet) {
      problems.push(
        `${urlSet ? MEMORY_HINDSIGHT_KEY_SECRET_ENV : MEMORY_HINDSIGHT_API_URL_ENV} is not set: the tab stays "not enabled" until both are set`,
      );
    }
    return {
      enabled: urlSet && urlValid && secretSet,
      problems,
      entries: [
        // The address is not shown: it can carry credentials; only whether it is usable.
        entry("Service address", urlSet ? (urlValid ? "set" : "invalid") : null, urlSet ? "env" : "default", MEMORY_HINDSIGHT_API_URL_ENV),
        entry("Key secret name", ctx.env[MEMORY_HINDSIGHT_KEY_SECRET_ENV]?.trim(), secretSet ? "env" : "default", MEMORY_HINDSIGHT_KEY_SECRET_ENV),
      ],
    };
  },

  health(ctx, config) {
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    if (!config.enabled) return healthOff("the memory service address and key secret are not set");
    const out = ctx.outcomes(AGENT_MEMORY_FEATURE_KEY);
    const base = {
      lastSuccessAt: iso(out.lastSuccessAt),
      ...errorFields(out),
      effect: { label: "memory service calls in 24 h", value: out.runs24h },
    };
    if (out.lastRunAt === null) {
      return makeHealth("unknown", "unknown — configured, but no memory card request since the server started", base);
    }
    if (out.lastOk === false) {
      return makeHealth("failing", `the last call to the memory service failed: ${out.lastError ?? "unknown error"}`, base);
    }
    return makeHealth("working", "the last call to the memory service succeeded", base);
  },
};
