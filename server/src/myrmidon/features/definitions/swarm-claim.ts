// myrmidon(FEATURES): swarm self-claim and idle wake.
//
// Health sources: the claim lines in activity_log (the effect), the sweeper's
// own passes (the recorder: "the loop is alive", idle wakes), and the last
// pass's view of the queues (free agents next to ready work).

import {
  SWARM_CLAIM_ENV_KEYS,
  SWARM_CLAIM_SETTINGS_KEY,
  SWARM_MATCHED_ACTION,
  resolveSwarmClaimSettings,
} from "@myrmidon/shared";
import { instanceSettingsService } from "../../../services/instance-settings.js";
import { swarmClaimSettingsService } from "../../swarm-claim/settings.js";
import { entry, errorFields, healthOff, iso, latestOf, makeHealth } from "../health.js";
import { SWARM_CLAIM_SWEEP_FEATURE_KEY } from "../reporters.js";
import type { FeatureDefinition } from "../types.js";

export const SWARM_CLAIM_FEATURE_KEY = SWARM_CLAIM_SWEEP_FEATURE_KEY;

export const swarmClaimFeature: FeatureDefinition = {
  key: SWARM_CLAIM_FEATURE_KEY,
  name: "Swarm self-claim and idle wake",
  description:
    "Idle agents of a role take ready tasks from the role queue under a lease, and the sweeper wakes free agents next to a non-empty queue.",
  docs: "docs/myrmidon/guides/swarm-claim-settings.md",
  settings: { path: "/company/settings", panel: "Role queues (SWARM-CLAIM)" },

  async readConfig(ctx) {
    const resolved = resolveSwarmClaimSettings({ stored: ctx.general[SWARM_CLAIM_SETTINGS_KEY], env: ctx.env });
    const { settings, sources } = resolved;
    const problems: string[] = [];
    return {
      enabled: settings.enabled,
      problems,
      toggle: { enabled: settings.enabled, lockedBy: sources.enabled === "env" ? "env" : null },
      entries: [
        entry("Enabled", settings.enabled, sources.enabled, SWARM_CLAIM_ENV_KEYS.enabled),
        entry("Lease TTL, s", settings.leaseTtlSec, sources.leaseTtlSec, SWARM_CLAIM_ENV_KEYS.leaseTtlSec),
        entry(
          "Max active tasks per agent",
          settings.maxActiveTasks === null ? "no ceiling" : settings.maxActiveTasks,
          sources.maxActiveTasks,
          SWARM_CLAIM_ENV_KEYS.maxActiveTasks,
        ),
        entry("Sweep interval, s", settings.sweepIntervalSec, sources.sweepIntervalSec, SWARM_CLAIM_ENV_KEYS.sweepIntervalSec),
      ],
    };
  },

  async health(ctx, config) {
    if (!config.enabled) return healthOff("the pilot switch is off");
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    const [matched, lastMatchedAt] = await Promise.all([
      ctx.ports.activity.count([SWARM_MATCHED_ACTION], ctx.since),
      ctx.ports.activity.latest([SWARM_MATCHED_ACTION]),
    ]);
    const out = ctx.outcomes(SWARM_CLAIM_FEATURE_KEY);
    const base = {
      lastSuccessAt: iso(latestOf(out.lastSuccessAt, lastMatchedAt)),
      ...errorFields(out),
      effect: { label: "tasks assigned to free agents in 24 h", value: matched },
    };
    if (out.lastOk === false) {
      return makeHealth("failing", `the last sweep pass failed: ${out.lastError ?? "unknown error"}`, base);
    }
    const detail = out.lastDetail ?? {};
    const unmatchedCount = typeof detail.idleUnmatchedTasks === "number" ? detail.idleUnmatchedTasks : 0;
    if (unmatchedCount > 0 && matched === 0 && out.effect24h === 0) {
      return makeHealth(
        "failing",
        `${unmatchedCount} ready task(s) were unmatched with free agents available but 0 tasks assigned in 24 h`,
        base,
      );
    }
    if (out.lastRunAt === null && matched === 0) {
      return makeHealth(
        "unknown",
        "unknown — no sweep pass since the server started and no tasks assigned in 24 h",
        base,
      );
    }
    return makeHealth(
      "working",
      matched > 0
        ? `${matched} task(s) assigned to free agents in 24 h`
        : "the sweeper runs; no ready work needed a claim in 24 h",
      base,
    );
  },

  async setEnabled(ctx, enabled, actor) {
    const service = swarmClaimSettingsService(ctx.db, {
      settings: instanceSettingsService(ctx.db),
      env: ctx.env,
    });
    await service.update({ enabled }, { actorType: actor.actorType, actorId: actor.actorId });
  },
};
