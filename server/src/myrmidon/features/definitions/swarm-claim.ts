// myrmidon(FEATURES): swarm self-claim and idle wake.
//
// Health sources: the claim lines in activity_log (the effect), the sweeper's
// own passes (the recorder: "the loop is alive", idle wakes), and the last
// pass's view of the queues (free agents next to ready work).

import {
  SWARM_CLAIM_CLAIMED_ACTION,
  SWARM_CLAIM_ENV_KEYS,
  SWARM_CLAIM_SETTINGS_KEY,
  resolveSwarmClaimSettings,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../../../services/instance-settings.js";
import { swarmClaimSettingsService } from "../../swarm-claim/settings.js";
import { SWARM_IDLE_WAKE_BATCH_ENV, readSwarmIdleWakeBatch } from "../../swarm-claim/sweep.js";
import { entry, envIsSet, errorFields, healthOff, iso, latestOf, listText, makeHealth } from "../health.js";
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
    if (settings.enabled) {
      if (settings.enabledCompanyIds.length > 0) {
        const ids = new Set(await ctx.ports.companies.ids());
        if (!settings.enabledCompanyIds.some((id) => ids.has(id))) {
          problems.push("the pilot company list matches no company on this instance, so nothing can claim");
        }
      }
      if (settings.enabledRoles.length > 0) {
        const roles = new Set((await ctx.ports.agents.roles()).map((role) => role.toLowerCase()));
        if (!settings.enabledRoles.some((role) => roles.has(role.toLowerCase()))) {
          problems.push("the pilot role list matches no agent role on this instance, so nothing can claim");
        }
      }
    }
    const batchSource = envIsSet(ctx.env, SWARM_IDLE_WAKE_BATCH_ENV) ? "env" : "default";
    return {
      enabled: settings.enabled,
      problems,
      toggle: { enabled: settings.enabled, lockedBy: sources.enabled === "env" ? "env" : null },
      entries: [
        entry("Enabled", settings.enabled, sources.enabled, SWARM_CLAIM_ENV_KEYS.enabled),
        entry("Pilot roles", listText(settings.enabledRoles, "all roles"), sources.enabledRoles),
        entry("Pilot companies", listText(settings.enabledCompanyIds, "all companies"), sources.enabledCompanyIds),
        entry("Lease TTL, s", settings.leaseTtlSec, sources.leaseTtlSec, SWARM_CLAIM_ENV_KEYS.leaseTtlSec),
        entry(
          "Max active tasks per agent",
          settings.maxActiveTasks === null ? "no ceiling" : settings.maxActiveTasks,
          sources.maxActiveTasks,
          SWARM_CLAIM_ENV_KEYS.maxActiveTasks,
        ),
        entry("Sweep interval, s", settings.sweepIntervalSec, sources.sweepIntervalSec, SWARM_CLAIM_ENV_KEYS.sweepIntervalSec),
        entry("Idle wake batch", readSwarmIdleWakeBatch(ctx.env), batchSource, SWARM_IDLE_WAKE_BATCH_ENV),
      ],
    };
  },

  async health(ctx, config) {
    if (!config.enabled) return healthOff("the pilot switch is off");
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    const [claims, lastClaimAt] = await Promise.all([
      ctx.ports.activity.count([SWARM_CLAIM_CLAIMED_ACTION], ctx.since),
      ctx.ports.activity.latest([SWARM_CLAIM_CLAIMED_ACTION]),
    ]);
    const out = ctx.outcomes(SWARM_CLAIM_FEATURE_KEY);
    const base = {
      lastSuccessAt: iso(latestOf(out.lastSuccessAt, lastClaimAt)),
      ...errorFields(out),
      effect: { label: "issues claimed in 24 h", value: claims },
    };
    if (out.lastOk === false) {
      return makeHealth("failing", `the last sweep pass failed: ${out.lastError ?? "unknown error"}`, base);
    }
    const detail = out.lastDetail ?? {};
    const freeAgents = typeof detail.idleFreeAgents === "number" ? detail.idleFreeAgents : 0;
    if (freeAgents > 0 && claims === 0 && out.effect24h === 0) {
      return makeHealth(
        "failing",
        `${freeAgents} free agent(s) sit next to a non-empty role queue and nothing was claimed or woken in 24 h`,
        base,
      );
    }
    if (out.lastRunAt === null && claims === 0) {
      return makeHealth(
        "unknown",
        "unknown — no sweep pass since the server started and no claim in 24 h",
        base,
      );
    }
    return makeHealth(
      "working",
      claims > 0
        ? `${claims} issue(s) claimed in 24 h`
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
