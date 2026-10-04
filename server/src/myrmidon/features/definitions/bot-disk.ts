// myrmidon(FEATURES): bot draft-directory lifecycle (the idle scratch and
// workspace clones of bot containers are reaped).
//
// Health source: the sweep's own report, recorded on every maintenance tick.
// The failure this entry exists for: the sweep listed a volume root that does
// not exist, failed with ENOENT on every pass, and only a console line said so.

import { BOT_DISK_ENV_KEYS, resolveBotDiskSettings } from "@paperclipai/shared";
import { botDiskService } from "../../bot-containers/bot-disk-service.js";
import { BOT_CONTAINERS_ENV, isBotContainersEnabled } from "../../bot-containers/agent-config.js";
import { BOT_VOLUME_ROOT_ENV } from "../../bot-containers/docker-driver.js";
import { entry, envIsSet, errorFields, healthOff, iso, makeHealth } from "../health.js";
import { BOT_DISK_FEATURE_KEY } from "../reporters.js";
import type { FeatureDefinition } from "../types.js";

export const botDiskFeature: FeatureDefinition = {
  key: BOT_DISK_FEATURE_KEY,
  name: "Bot disk lifecycle",
  description:
    "Reaps idle scratch and workspace clones of bot containers after a TTL; the memory volume is never touched.",
  docs: "docs/myrmidon/bot-disk-cache.md",
  // The switch is inline on the features page; the idle TTL is set through PATCH /api/myrmidon/bot-disk.

  readConfig(ctx) {
    const { settings, sources } = resolveBotDiskSettings({ stored: ctx.general.botDisk, env: ctx.env });
    const containers = isBotContainersEnabled(ctx.env);
    const root = ctx.env[BOT_VOLUME_ROOT_ENV]?.trim();
    const problems: string[] = [];
    if (settings.enabled && containers && !root) {
      problems.push(
        `${BOT_VOLUME_ROOT_ENV} is not set: the sweep falls back to a fixed path that is not the bot volume root, so it cannot find any bot volume`,
      );
    }
    return {
      enabled: settings.enabled,
      problems,
      toggle: { enabled: settings.enabled, lockedBy: null },
      entries: [
        entry("Enabled", settings.enabled, sources.enabled, BOT_DISK_ENV_KEYS.enabled),
        entry("Idle TTL", `${Math.round(settings.idleTtlMs / 60_000)} min`, sources.idleTtlMs, BOT_DISK_ENV_KEYS.idleTtlMs),
        entry("Bot containers", containers ? "on" : "off", envIsSet(ctx.env, BOT_CONTAINERS_ENV) ? "env" : "default", BOT_CONTAINERS_ENV),
        entry("Bot volume root", root, root ? "env" : "default", BOT_VOLUME_ROOT_ENV),
      ],
    };
  },

  health(ctx, config) {
    if (!config.enabled) return healthOff("the lifecycle switch is off");
    if (!isBotContainersEnabled(ctx.env)) {
      return healthOff("bot containers are not enabled, so there are no bot volumes to sweep");
    }
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    const out = ctx.outcomes(BOT_DISK_FEATURE_KEY);
    const base = {
      lastSuccessAt: iso(out.lastSuccessAt),
      ...errorFields(out),
      effect: { label: "draft directories reaped in 24 h", value: out.effect24h },
    };
    if (out.lastRunAt === null) {
      return makeHealth("unknown", "unknown — no sweep pass since the server started", base);
    }
    if (out.lastOk === false) {
      const code = out.lastDetail?.rootErrorCode;
      if (code === "ENOENT") {
        return makeHealth(
          "misconfigured",
          `the bot volume root does not exist, so every pass fails: ${out.lastError ?? "ENOENT"}`,
          base,
        );
      }
      return makeHealth("failing", `the last sweep pass failed: ${out.lastError ?? "unknown error"}`, base);
    }
    return makeHealth("working", "the sweep runs on every maintenance tick", base);
  },

  async setEnabled(ctx, enabled, actor) {
    await botDiskService(ctx.db).update({ enabled }, actor);
  },
};
