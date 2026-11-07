/**
 * Configuration and environment reader for STACK-UPDATES-B Release Reconciliation.
 *
 * All tags, repo targets, and API addresses are extracted from environment variables
 * with safe defaults.
 */

import type { ReleaseReconciliationConfig } from "./types.js";

export const DEFAULT_VENDOR_GITHUB_REPO = "paperclipai/paperclip";
export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
export const DEFAULT_RECONCILIATION_INTERVAL_SEC = 86400; // 24 hours / once a day

export const ENV_VARS = {
  currentRelease: ["MYRMIDON_CURRENT_RELEASE", "CURRENT_RELEASE"],
  vendorRepo: ["MYRMIDON_VENDOR_GITHUB_REPO", "VENDOR_GITHUB_REPO"],
  gitHubApiBase: ["MYRMIDON_GITHUB_API_BASE", "GITHUB_API_URL"],
  vendorTag: ["MYRMIDON_VENDOR_TAG", "VENDOR_TAG"],
  gitHubToken: ["MYRMIDON_STACK_GITHUB_TOKEN", "GITHUB_TOKEN"],
  intervalSec: ["MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC"],
  companyId: ["MYRMIDON_RELEASE_TASK_COMPANY_ID"],
} as const;

function getFirstEnv(env: Record<string, string | undefined>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = env[key];
    if (val !== undefined && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

export function readReleaseReconciliationConfig(
  env: Record<string, string | undefined> = process.env,
): ReleaseReconciliationConfig {
  const currentRelease = getFirstEnv(env, ENV_VARS.currentRelease) ?? null;
  const vendorRepo = getFirstEnv(env, ENV_VARS.vendorRepo) ?? DEFAULT_VENDOR_GITHUB_REPO;
  const rawApiBase = getFirstEnv(env, ENV_VARS.gitHubApiBase) ?? DEFAULT_GITHUB_API_BASE;
  const gitHubApiBase = rawApiBase.replace(/\/+$/, "");
  const vendorTagOverride = getFirstEnv(env, ENV_VARS.vendorTag) ?? null;
  const gitHubToken = getFirstEnv(env, ENV_VARS.gitHubToken) ?? null;

  const rawInterval = getFirstEnv(env, ENV_VARS.intervalSec);
  let intervalSec = DEFAULT_RECONCILIATION_INTERVAL_SEC;
  if (rawInterval) {
    const parsed = Number.parseInt(rawInterval, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      intervalSec = parsed;
    }
  }

  const companyId = getFirstEnv(env, ENV_VARS.companyId) ?? null;

  return {
    currentRelease,
    vendorRepo,
    gitHubApiBase,
    vendorTagOverride,
    gitHubToken,
    intervalSec,
    companyId,
  };
}
