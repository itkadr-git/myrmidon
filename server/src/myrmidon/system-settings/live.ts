// myrmidon(1.7, OPE-4101, SETTINGS-TO-UI E): live readers for the system and
// monitoring settings. Each helper resolves the value through the part A
// process-wide view (stored UI value → env forced override → default); the env
// argument only provides the forced-override layer so consumers that already
// hold a specific env (tests, startup probes) keep working unchanged.

import "@paperclipai/shared/myrmidon-system-settings"; // registers the keys
import { liveBehaviorSetting } from "../behavior-settings/live.js";

function envOverride<T>(env: NodeJS.ProcessEnv, envName: string, parse: (raw: string) => T | null): T | null {
  const raw = env[envName]?.trim();
  if (!raw) return null;
  return parse(raw);
}

function parseBoolean(raw: string): boolean | null {
  const lower = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return null;
}

function parseIntInRange(min: number, max: number) {
  return (raw: string): number | null => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return null;
    return value;
  };
}

function parseList(raw: string): string[] | null {
  const out = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return out.length > 0 ? out : null;
}

function resolve<T>(
  env: NodeJS.ProcessEnv,
  envName: string,
  key: string,
  parse: (raw: string) => T | null,
  defaultValue: T,
): T {
  const override = envOverride(env, envName, parse);
  if (override !== null) return override;
  return liveBehaviorSetting<T>(key) ?? defaultValue;
}

/** Deploy smoke parameters (OPE-4101, section system). */
export function liveDeploySettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: resolve(env, "MYRMIDON_DEPLOY_ENABLED", "system.deploy.enabled", parseBoolean, false),
    autoRollback: resolve(env, "MYRMIDON_DEPLOY_AUTO_ROLLBACK", "system.deploy.autoRollback", parseBoolean, true),
    autoUpdate: resolve(env, "MYRMIDON_DEPLOY_AUTO_UPDATE", "system.deploy.autoUpdate", parseBoolean, false),
    verifyTimeoutSec: resolve(env, "MYRMIDON_DEPLOY_VERIFY_TIMEOUT_SEC", "system.deploy.verifyTimeoutSec", parseIntInRange(1, 300), 30),
    tickSec: resolve(env, "MYRMIDON_DEPLOY_TICK_SEC", "system.deploy.tickSec", parseIntInRange(1, 3600), 5),
    stepTimeoutSec: resolve(env, "MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC", "system.deploy.stepTimeoutSec", parseIntInRange(10, 86400), 1800),
    healthPollSec: resolve(env, "MYRMIDON_DEPLOY_HEALTH_POLL_SEC", "system.deploy.healthPollSec", parseIntInRange(1, 300), 5),
    healthTimeoutSec: resolve(env, "MYRMIDON_DEPLOY_HEALTH_TIMEOUT_SEC", "system.deploy.healthTimeoutSec", parseIntInRange(10, 3600), 300),
  };
}

/** Tracing health windows (OPE-4101, section system). */
export function liveTracingHealthSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    windowSec: resolve(env, "MYRMIDON_TRACING_WINDOW_SEC", "system.tracing.windowSec", parseIntInRange(60, 3600), 900),
    healthTtlSec: resolve(env, "MYRMIDON_TRACING_HEALTH_TTL_SEC", "system.tracing.healthTtlSec", parseIntInRange(5, 3600), 60),
    signalIntervalSec: resolve(env, "MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC", "system.tracing.signalIntervalSec", parseIntInRange(30, 86400), 300),
  };
}

/** Zabbix maintenance windows (OPE-4101, section system). */
export function liveZabbixSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    hostGroups: resolve(env, "MYRMIDON_ZABBIX_HOST_GROUPS", "system.zabbix.hostGroups", parseList, [] as string[]),
    maxWindowSec: resolve(env, "MYRMIDON_ZABBIX_MAX_WINDOW_SEC", "system.zabbix.maxWindowSec", parseIntInRange(60, 604800), 14_400),
  };
}
