// Forgotten-pause guard settings (myrmidon 1.6.5 PAUSE-GUARD).
//
// The environment holds the values for an instance in the deployment
// (`MYRMIDON_PAUSE_GUARD_*`); `instance_settings.general.pauseGuard` becomes
// the source of truth once an operator saves the block from the settings
// page, and this module resolves the two the same way the run admission
// limits are resolved. The value rules and the bounds live in
// packages/shared/src/myrmidon-pause-guard.ts; reading them out of a
// NodeJS.ProcessEnv is the job of this file.
//
// The feature is a defect fix (CONVENTIONS.md section 8): it ships enabled and
// only an explicit off value disables it.

import {
  DEFAULT_PAUSE_GUARD_INTERVAL_SEC,
  DEFAULT_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  DEFAULT_PAUSE_GUARD_THRESHOLD_MINUTES,
  MAX_PAUSE_GUARD_INTERVAL_SEC,
  MAX_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  MAX_PAUSE_GUARD_THRESHOLD_MINUTES,
  MIN_PAUSE_GUARD_INTERVAL_SEC,
  MIN_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  MIN_PAUSE_GUARD_THRESHOLD_MINUTES,
  PAUSE_GUARD_ENV_KEYS,
  isAllowlistedName,
  readPauseGuardSettingsFromEnv,
  resolvePauseGuardSettings,
  type PauseGuardSettingKey,
  type PauseGuardSettings,
  type PauseGuardSettingsSource,
  type ResolvedPauseGuardSettings,
} from "@paperclipai/shared";

export {
  DEFAULT_PAUSE_GUARD_INTERVAL_SEC,
  DEFAULT_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  DEFAULT_PAUSE_GUARD_THRESHOLD_MINUTES,
  MAX_PAUSE_GUARD_INTERVAL_SEC,
  MAX_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  MAX_PAUSE_GUARD_THRESHOLD_MINUTES,
  MIN_PAUSE_GUARD_INTERVAL_SEC,
  MIN_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  MIN_PAUSE_GUARD_THRESHOLD_MINUTES,
  PAUSE_GUARD_ENV_KEYS,
  isAllowlistedName,
  resolvePauseGuardSettings,
  type PauseGuardSettingKey,
  type PauseGuardSettings,
  type PauseGuardSettingsSource,
  type ResolvedPauseGuardSettings,
};

/** The settings as the environment declares them (defaults for anything unset). */
export function readPauseGuardSettings(env: NodeJS.ProcessEnv = process.env): PauseGuardSettings {
  return readPauseGuardSettingsFromEnv(env);
}

/** The stored row plus the environment, resolved to the settings in force. */
export function pauseGuardSettingsFor(options: {
  stored?: unknown;
  env?: NodeJS.ProcessEnv;
} = {}): ResolvedPauseGuardSettings {
  return resolvePauseGuardSettings({ stored: options.stored, env: options.env ?? process.env });
}

/** The threshold as a millisecond window; the sweep counts back from `now`. */
export function pauseGuardThresholdMs(settings: PauseGuardSettings): number {
  return settings.thresholdMinutes * 60 * 1000;
}

/** The interval between two sweep passes, in milliseconds. */
export function pauseGuardIntervalMs(settings: PauseGuardSettings): number {
  return settings.intervalSec * 1000;
}