// myrmidon(FEATURES): execution holds health (OPE-7707).
//
// Tracks whether tasks are held by execution recovery replay=blocked.
// When tasks are held, warns that work cannot be claimed by engineers.

import { entry, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const EXECUTION_HOLDS_FEATURE_KEY = "execution-holds";
const CLEAR_ACTION = "issue.execution_recovery_replay_cleared";

export const executionHoldsFeature: FeatureDefinition = {
  key: EXECUTION_HOLDS_FEATURE_KEY,
  name: "Execution recovery holds",
  description:
    "Protects tasks from uncertain replay on crash until cleared, reassigned, or expired after 24h.",
  docs: "docs/myrmidon/DIVERGENCE.md",

  readConfig() {
    return {
      enabled: true,
      entries: [entry("Auto-clear on reassign/success/24h", "active", "default")],
    };
  },

  async health(ctx) {
    const [clears, lastClear] = await Promise.all([
      ctx.ports.activity.count([CLEAR_ACTION], ctx.since),
      ctx.ports.activity.latest([CLEAR_ACTION]),
    ]);

    const base = {
      lastSuccessAt: iso(lastClear),
      effect: { label: "holds cleared in 24 h", value: clears },
    };

    if (clears > 0) {
      return makeHealth(
        "working",
        `${clears} execution recovery hold(s) cleared in 24 h`,
        base,
      );
    }
    return makeHealth(
      "unknown",
      "unknown — no execution hold was cleared in 24 h: either no tasks were held or no hold cleared yet",
      base,
    );
  },
};
