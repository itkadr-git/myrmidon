// Run stall detection settings (MYRMIDON_RUN_STALL_*). See docs/myrmidon/SETTINGS.md.
//
// The feature is a defect fix (CONVENTIONS.md §8): it ships enabled and only an
// explicit off value disables it. The threshold is a deployment value, so the
// default is the neutral 20 minutes the operator's own watchdog script used.
//
// myrmidon(RUN-STALL-SETTINGS, 1.6.5): the names, the defaults, the
// bounds and the env parsing semantics moved to the shared contract
// (packages/shared/src/myrmidon-run-stall.ts), where the settings-page read
// path uses them; this module re-exports the names and keeps the millisecond
// view the sweep works in.

import { readRunStallFromEnv } from "@paperclipai/shared";

export {
  DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC,
  DEFAULT_RUN_STALL_PAGE_SIZE,
  DEFAULT_RUN_STALL_THRESHOLD_SEC,
  MAX_RUN_STALL_CHECK_INTERVAL_SEC,
  MAX_RUN_STALL_PAGE_SIZE,
  MAX_RUN_STALL_THRESHOLD_SEC,
  MIN_RUN_STALL_CHECK_INTERVAL_SEC,
  MIN_RUN_STALL_PAGE_SIZE,
  MIN_RUN_STALL_THRESHOLD_SEC,
  RUN_STALL_CHECK_INTERVAL_SEC_ENV,
  RUN_STALL_ENABLED_ENV,
  RUN_STALL_PAGE_SIZE_ENV,
  RUN_STALL_THRESHOLD_SEC_ENV,
} from "@paperclipai/shared";

export interface RunStallSettings {
  enabled: boolean;
  /** Silence window after which a run with no recorded progress counts as stalled. */
  thresholdMs: number;
  /** Minimum spacing between two scan passes. */
  checkIntervalMs: number;
  /** Ceiling on runs inspected in one pass. */
  pageSize: number;
}

/**
 * Master switch. Unset or an unrecognized value keeps the fix on: a typo must
 * not silently extinguish it (`MYRMIDON_IDLE_PICKUP_ENABLED` follows the same
 * rule).
 */
export function readRunStallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRunStallFromEnv(env).enabled;
}

export function readRunStallSettings(env: NodeJS.ProcessEnv = process.env): RunStallSettings {
  const values = readRunStallFromEnv(env);
  return {
    enabled: values.enabled,
    thresholdMs: values.thresholdSec * 1000,
    checkIntervalMs: values.checkIntervalSec * 1000,
    pageSize: values.pageSize,
  };
}
