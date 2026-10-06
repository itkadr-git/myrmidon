// myrmidon(FEATURES): run admission (instance-wide run limits and the host
// memory floor).
//
// Health source: the process-wide admission itself — the floor's gate state is
// read live, the same rule every run start goes through. A floor that is set
// but cannot read the host memory is the quiet failure this page exists for:
// the guard passes everything and nobody notices.

import { RUN_LIMITS_ENV_KEYS, resolveRunLimits } from "@paperclipai/shared";
import { HOST_MEMINFO_PATH_ENV } from "../../run-admission.js";
import { entry, healthOff, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const RUN_ADMISSION_FEATURE_KEY = "run-admission";

function limitText(value: number | null, unit = ""): string {
  return value === null ? "no limit" : `${value}${unit}`;
}

export const runAdmissionFeature: FeatureDefinition = {
  key: RUN_ADMISSION_FEATURE_KEY,
  name: "Run admission",
  description:
    "Instance-wide limits on concurrent runs, run starts per minute and free memory (the server and the host), so a mass wake cannot exhaust the machine.",
  docs: "docs/myrmidon/guides/run-limits.md",
  settings: { path: "/company/settings", panel: "Run limits" },

  readConfig(ctx) {
    const { limits, sources } = resolveRunLimits({ stored: ctx.general.runLimits, env: ctx.env });
    const anyLimit =
      limits.maxConcurrentRuns !== null ||
      limits.maxStartsPerMinute !== null ||
      limits.minFreeMemoryMb !== null ||
      limits.minFreeHostMemoryMb !== null;
    const meminfo = ctx.env[HOST_MEMINFO_PATH_ENV]?.trim();
    return {
      enabled: anyLimit,
      entries: [
        entry("Concurrent runs", limitText(limits.maxConcurrentRuns), sources.maxConcurrentRuns, RUN_LIMITS_ENV_KEYS.maxConcurrentRuns),
        entry("Run starts per minute", limitText(limits.maxStartsPerMinute), sources.maxStartsPerMinute, RUN_LIMITS_ENV_KEYS.maxStartsPerMinute),
        entry("Server free memory floor", limitText(limits.minFreeMemoryMb, " MB"), sources.minFreeMemoryMb, RUN_LIMITS_ENV_KEYS.minFreeMemoryMb),
        entry(
          "Host free memory floor",
          limitText(limits.minFreeHostMemoryMb, " MB"),
          sources.minFreeHostMemoryMb,
          RUN_LIMITS_ENV_KEYS.minFreeHostMemoryMb,
        ),
        entry("Run memory budget", `${limits.runMemoryEstimateMb} MB`, sources.runMemoryEstimateMb, RUN_LIMITS_ENV_KEYS.runMemoryEstimateMb),
        entry("Host meminfo path", meminfo || "/proc/meminfo", meminfo ? "env" : "default", HOST_MEMINFO_PATH_ENV),
      ],
    };
  },

  async health(ctx, config) {
    if (!config.enabled) return healthOff("no run limit is set");
    const state = ctx.ports.runtime.runAdmission();
    const [queued, lastStartedAt] = await Promise.all([
      ctx.ports.runs.queuedCount(),
      ctx.ports.runs.lastStartedAt(),
    ]);
    const base = {
      lastSuccessAt: iso(lastStartedAt),
      effect: { label: "runs held in the queue now", value: queued },
    };
    if (state.gate.state === "unknown") {
      return makeHealth(
        "misconfigured",
        `the host memory floor is set but host memory cannot be read, so the floor is inactive: ${state.gate.reason ?? "no reason given"}`,
        base,
      );
    }
    if (state.gate.state === "closed") {
      const since = state.gate.heldSince ? ` since ${state.gate.heldSince.toISOString()}` : "";
      return makeHealth(
        "working",
        `the host memory floor is closed${since} and holds new runs back (${state.gate.reason ?? "free memory below the floor"})`,
        base,
      );
    }
    return makeHealth("working", "admission checks every run start", base);
  },
};
