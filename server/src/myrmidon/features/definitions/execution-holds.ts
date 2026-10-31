// myrmidon(1.6.6 FEATURE-HEALTH & FEATURES): execution holds health (OPE-7707 & OPE-9923).
//
// Tracks whether tasks are held by execution recovery replay=blocked.
// Protects tasks from uncertain replay on crash until cleared, reassigned, or
// expired after 24h, and monitors open tasks held with replay=blocked.
// When open tasks are held for more than 24 hours without operator release or
// automated reconciliation, health status becomes failing (broken), raising an
// operator attention card and alerting via Zabbix.

import { entry, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const EXECUTION_HOLDS_FEATURE_KEY = "execution-holds";
const CLEAR_ACTION = "issue.execution_recovery_replay_cleared";

export const executionHoldsFeature: FeatureDefinition = {
  key: EXECUTION_HOLDS_FEATURE_KEY,
  name: "Execution holds (HOLD-READY)",
  description:
    "Protects tasks from uncertain replay on crash until cleared, reassigned, or expired after 24h, monitoring open tasks held with replay=blocked.",
  docs: "docs/myrmidon/guides/features-page.md#execution-holds",

  readConfig() {
    return {
      enabled: true,
      entries: [
        entry("Auto-clear on reassign/success/24h", "active", "default"),
        entry("Switch", "always on (monitors open issue recovery holds)", "default"),
      ],
    };
  },

  async health(ctx) {
    const [{ count, oldestAt }, clears, lastClear] = await Promise.all([
      ctx.ports.executionHolds.stats(),
      ctx.ports.activity.count([CLEAR_ACTION], ctx.since),
      ctx.ports.activity.latest([CLEAR_ACTION]),
    ]);

    const base = {
      effect: { label: "open tasks with replay=blocked", value: count },
      lastSuccessAt: iso(lastClear),
    };

    if (count === 0) {
      const clearsSuffix = clears > 0 ? ` (${clears} hold(s) cleared in 24 h)` : "";
      return makeHealth(
        "working",
        `no open tasks with execution holds (replay=blocked)${clearsSuffix}`,
        base,
      );
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
