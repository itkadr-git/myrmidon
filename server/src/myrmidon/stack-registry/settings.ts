// Stack registry (SUA, part B) settings. See docs/myrmidon/SETTINGS.md.

import { liveSavedSetting } from "../behavior-settings/live.js";
import { STACK_BACKLOG_LAG_DEFAULT } from "./backlog-draft.js";

export const STACK_CHECK_INTERVAL_ENV = "MYRMIDON_STACK_CHECK_INTERVAL_SEC";

/** Never hammer the release sources: an explicit interval below this is lifted to it. */
export const STACK_CHECK_MIN_INTERVAL_SEC = 60;

/**
 * How often the scheduled release check runs, in seconds. Zero (the default) or
 * unset means the sweep is off: the board does not touch the network until an
 * operator enables it. An invalid value falls back to off — a typo must not
 * silently start a daily network call.
 */
export function readStackCheckIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  const saved = env === process.env ? liveSavedSetting<number>("stack_check_interval_sec") : undefined;
  const raw = saved !== undefined ? String(saved) : env[STACK_CHECK_INTERVAL_ENV]?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 0;
  if (value === 0) return 0;
  return Math.max(value, STACK_CHECK_MIN_INTERVAL_SEC);
}

export const STACK_GITHUB_TOKEN_ENV = "MYRMIDON_STACK_GITHUB_TOKEN";

/**
 * Optional read-only GitHub token for the release check (secret class: the
 * value is never logged and never returned by any route). Unset or blank means
 * anonymous requests — the 60 req/h per egress IP budget. A token lifts the
 * budget to 5000 req/h. Trimmed; whitespace-only reads as not set.
 */
export function readStackGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[STACK_GITHUB_TOKEN_ENV]?.trim();
  return raw ? raw : null;
}

export const STACK_OSV_API_BASE_ENV = "MYRMIDON_STACK_OSV_API_BASE";

/**
 * Optional base URL for OSV.dev advisory API.
 * Unset or blank falls back to https://api.osv.dev.
 */
export function readStackOsvApiBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[STACK_OSV_API_BASE_ENV]?.trim();
  return raw ? raw : null;
}

export const STACK_BACKLOG_LAG_RELEASES_ENV = "MYRMIDON_STACK_BACKLOG_LAG_RELEASES";

/**
 * Minimum upstream lag in releases that warrants a backlog draft task.
 * Defaults to 2.
 */
export function readStackBacklogLagReleases(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STACK_BACKLOG_LAG_RELEASES_ENV]?.trim();
  if (!raw) return STACK_BACKLOG_LAG_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return STACK_BACKLOG_LAG_DEFAULT;
  return value;
}
