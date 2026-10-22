// myrmidon(FEATURES): the call sites modules use to report a pass of their own
// sweep to the features page. They live apart from the definitions so a module
// can import its reporter without importing its definition (which imports the
// module's services: a cycle).

import type { BotDiskSweepReport } from "../bot-containers/draft-lifecycle.js";
import { recordFeatureOutcome } from "./recorder.js";

export const BOT_DISK_FEATURE_KEY = "bot-disk-lifecycle";
export const COST_ATTRIBUTION_FEATURE_KEY = "cost-attribution";
export const SWARM_CLAIM_SWEEP_FEATURE_KEY = "swarm-claim";
export const AGENT_MEMORY_FEATURE_KEY = "agent-memory";
export const SHARED_PACKAGE_CACHE_FEATURE_KEY = "shared-package-cache";

/** One pass of the bot draft-directory sweep. `report` is null when the pass itself threw. */
export function recordBotDiskSweepOutcome(report: BotDiskSweepReport | null, err?: unknown): void {
  if (report === null) {
    recordFeatureOutcome(BOT_DISK_FEATURE_KEY, {
      ok: false,
      error: err instanceof Error ? err.message : String(err ?? "the sweep threw"),
    });
    return;
  }
  if (report.skipped) return; // switched off: not a pass of the feature
  if (report.rootError) {
    recordFeatureOutcome(BOT_DISK_FEATURE_KEY, {
      ok: false,
      error: `${report.rootError.code ?? "error"}: ${report.rootError.message}`,
      detail: { rootErrorCode: report.rootError.code },
    });
    return;
  }
  if (report.errors > 0) {
    recordFeatureOutcome(BOT_DISK_FEATURE_KEY, {
      ok: false,
      error: `${report.errors} director${report.errors === 1 ? "y" : "ies"} could not be processed: ${report.firstError ?? "unknown error"}`,
      effect: report.reaped,
    });
    return;
  }
  recordFeatureOutcome(BOT_DISK_FEATURE_KEY, { ok: true, effect: report.reaped });
}

/** The text of a bot container reconcile error as the sink gets it. */
const MOUNT_REFUSED = "mount_source_not_allowed";

/**
 * One event of the bot container reconciler (its activity sink). A refused bind
 * mount or a successful recreate is the only evidence the shared package cache
 * has; every other event is not about it.
 */
export function reportBotContainerEvent(event: {
  level: "info" | "error";
  message: string;
  details?: Record<string, unknown>;
}): void {
  if (event.level === "error") {
    const raw = event.details?.error;
    const text = typeof raw === "string" ? raw : event.message;
    if (text.includes(MOUNT_REFUSED)) {
      recordFeatureOutcome(SHARED_PACKAGE_CACHE_FEATURE_KEY, { ok: false, error: text });
    }
    return;
  }
  if (event.message.startsWith("bot container recreated")) {
    recordFeatureOutcome(SHARED_PACKAGE_CACHE_FEATURE_KEY, { ok: true, effect: 1 });
  }
}
