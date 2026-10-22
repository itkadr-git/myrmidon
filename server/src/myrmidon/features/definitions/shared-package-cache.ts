// myrmidon(FEATURES): the shared package cache of development bots.
//
// Health source: the bot container reconciler. The cache binds are accepted by
// the docker socket filter only when its configuration names the same root; a
// refusal (`mount_source_not_allowed`) is the failure this entry exists for —
// the deploy did not update the filter and nobody saw the bots fail to start.
// A bot recreated with the binds is the positive signal. Without either the
// entry says unknown rather than guessing.

import { botDiskCachePathProblem, resolveSharedPackageCachePath } from "@paperclipai/shared";
import { isBotContainersEnabled } from "../../bot-containers/agent-config.js";
import { entry, errorFields, healthOff, iso, makeHealth } from "../health.js";
import { SHARED_PACKAGE_CACHE_FEATURE_KEY } from "../reporters.js";
import type { FeatureDefinition } from "../types.js";

const SUBDIRS = ["pnpm", "go-mod", "go-build", "gradle"] as const;

export const sharedPackageCacheFeature: FeatureDefinition = {
  key: SHARED_PACKAGE_CACHE_FEATURE_KEY,
  name: "Shared package cache",
  description:
    "One set of pnpm, Go and Gradle cache directories mounted read-write into every development bot container on the board host.",
  docs: "docs/myrmidon/bot-disk-cache.md",
  settings: { path: "/company/settings", panel: "Shared package cache for bots" },

  readConfig(ctx) {
    const path = resolveSharedPackageCachePath(ctx.general.botDisk);
    const problems: string[] = [];
    if (path) {
      const problem = botDiskCachePathProblem(path);
      if (problem) problems.push(`the cache path ${problem}`);
    }
    return {
      enabled: Boolean(path),
      problems,
      entries: [
        entry("Cache path", path, path ? "settings" : "default"),
        entry("Subdirectories", path ? SUBDIRS.join(", ") : null, "derived"),
        entry("Docker socket filter", "must name the same root as packageCacheRoot (not readable from here)", "derived"),
      ],
    };
  },

  health(ctx, config) {
    if (!config.enabled) return healthOff("no cache path is set");
    if (!isBotContainersEnabled(ctx.env)) {
      return healthOff("bot containers are not enabled, so no bot gets the cache binds");
    }
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    const out = ctx.outcomes(SHARED_PACKAGE_CACHE_FEATURE_KEY);
    const base = {
      lastSuccessAt: iso(out.lastSuccessAt),
      ...errorFields(out),
      effect: { label: "bots recreated with the cache binds in 24 h", value: out.effect24h },
    };
    if (out.lastOk === false) {
      return makeHealth(
        "failing",
        "the docker socket filter refused a bind mount. If the cache path was set recently, set the same directory as packageCacheRoot in the filter configuration and send it SIGHUP",
        base,
      );
    }
    if (out.lastSuccessAt) {
      return makeHealth("working", "a bot was recreated with the cache binds and the filter accepted them", base);
    }
    return makeHealth(
      "unknown",
      "unknown — no bot was recreated since the server started, so the socket filter has not been exercised with the cache binds",
      base,
    );
  },
};
