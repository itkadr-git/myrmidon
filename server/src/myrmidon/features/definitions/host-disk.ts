// myrmidon(FEATURES): the host disk usage signal.
//
// Health source: the sweep's last result, held in the process (usage, error).
// A data root that cannot be measured is the failure that matters: the signal
// would then never fire, whatever the disk does.

import { HOST_DISK_ENV_KEYS, resolveHostDiskSettings } from "@paperclipai/shared";
import { entry, envIsSet, healthUnknown, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const HOST_DISK_FEATURE_KEY = "host-disk";
const DATA_ROOT_ENV = "MYRMIDON_HOST_DISK_DATA_ROOT";
const CONSUMER_PATHS_ENV = "MYRMIDON_HOST_DISK_CONSUMER_PATHS";

export const hostDiskFeature: FeatureDefinition = {
  key: HOST_DISK_FEATURE_KEY,
  name: "Host disk signal",
  description:
    "Measures the disk the server's data lives on and raises an attention signal, with the biggest consumers, when usage crosses a threshold.",
  docs: "docs/myrmidon/host-disk.md",
  settings: { path: "/company/settings", panel: "Host disk" },

  readConfig(ctx) {
    const { settings, sources } = resolveHostDiskSettings({ stored: ctx.general.hostDisk, env: ctx.env });
    const root = ctx.env[DATA_ROOT_ENV]?.trim();
    return {
      enabled: null,
      entries: [
        entry("Alert threshold, % used", settings.usageThresholdPercent, sources.usageThresholdPercent, HOST_DISK_ENV_KEYS.usageThresholdPercent),
        entry("Measured path", root || "/data", root ? "env" : "default", DATA_ROOT_ENV),
        entry(
          "Consumer paths",
          ctx.env[CONSUMER_PATHS_ENV]?.trim() || "the measured path",
          envIsSet(ctx.env, CONSUMER_PATHS_ENV) ? "env" : "default",
          CONSUMER_PATHS_ENV,
        ),
      ],
    };
  },

  health(ctx) {
    const state = ctx.ports.runtime.hostDisk();
    if (!state) return healthUnknown("no sweep pass since the server started");
    if (state.error) {
      return makeHealth(
        "misconfigured",
        `the data root cannot be measured (${state.error}), so the signal can never fire; set ${DATA_ROOT_ENV} to a directory the server can read`,
        { lastError: { at: state.at, message: state.error } },
      );
    }
    return makeHealth(
      "working",
      state.overThreshold
        ? `the disk is over the ${state.thresholdPercent}% threshold and the signal is raised`
        : "the disk is measured on every sweep",
      {
        lastSuccessAt: iso(new Date(state.at)),
        effect: { label: "disk used", value: state.usedPercent, unit: "%" },
      },
    );
  },
};
