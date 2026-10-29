// myrmidon(1.6.6 FEATURE-HEALTH): execution holds — monitors open tasks held
// with automaticRecovery.replay = 'blocked' in issue_recovery_actions.
//
// When open tasks are held for more than 24 hours without operator release or
// automated reconciliation, health status becomes failing (broken), raising an
// operator attention card and alerting via Zabbix.

import { entry, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const EXECUTION_HOLDS_FEATURE_KEY = "execution-holds";

export const executionHoldsFeature: FeatureDefinition = {
  key: EXECUTION_HOLDS_FEATURE_KEY,
  name: "Execution holds (HOLD-READY)",
  description:
    "Monitors open tasks held with replay=blocked awaiting recovery reconciliation or operator release.",
  docs: "docs/myrmidon/guides/features-page.md#execution-holds",

  readConfig() {
    return {
      enabled: null,
      entries: [entry("Switch", "always on (monitors open issue recovery holds)", "default")],
    };
  },

  async health(ctx) {
    const { count, oldestAt } = await ctx.ports.executionHolds.stats();
    const base = {
      effect: { label: "open tasks with replay=blocked", value: count },
      lastSuccessAt: null,
    };

    if (count === 0) {
      return makeHealth("working", "no open tasks with execution holds (replay=blocked)", base);
    }

    const oldestAgeMs = oldestAt ? Math.max(0, ctx.now.getTime() - oldestAt.getTime()) : 0;
    const oldestAgeHours = Math.floor(oldestAgeMs / 3_600_000);

    if (oldestAgeHours >= 24) {
      return makeHealth(
        "failing",
        `${count} open task(s) held with replay=blocked; oldest held for ${oldestAgeHours} h (>24 h)`,
        base,
      );
    }

    return makeHealth(
      "working",
      `${count} open task(s) held with replay=blocked; none older than 24 h (oldest ${oldestAgeHours} h)`,
      base,
    );
  },
};
