// myrmidon(1.7, OPE-4101, SETTINGS-TO-UI E): system and monitoring behavior
// settings registered in the part A registry (instance scope, section
// "system"). These keys are resolved live (UI value → env forced override →
// default) and applied without a restart; consumers read them via
// `liveBehaviorSetting` / `resolveBehaviorSettings`, never by caching env at
// startup.
//
// Infra values (addresses, sockets, credentials, image digests, build facts)
// are NOT behavior settings: they stay env-only and surface in the UI through
// the read-only "Deployment" status block (see server/src/myrmidon/about).

import {
  behaviorSettingRegistry,
  type BehaviorSettingDef,
} from "./myrmidon-behavior-settings.js";

/** Boolean from a stored boolean or an env-style string. */
function validateBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return true;
    if (["false", "0", "no", "off"].includes(lower)) return false;
  }
  return null;
}

/** Integer within [min, max] from a stored number or an env-style string. */
function validateIntRange(min: number, max: number) {
  return (value: unknown): number | null => {
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (Number.isInteger(num) && num >= min && num <= max) return num;
    return null;
  };
}

/** "a,b , c" / ["a", "b"] → ["a", "b", "c"]; other shapes → the default. */
function validateStringList(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
    return out.length > 0 ? out : null;
  }
  if (typeof value === "string") {
    const out = value.split(",").map((v) => v.trim()).filter(Boolean);
    return out.length > 0 ? out : null;
  }
  return null;
}

function register<T>(def: BehaviorSettingDef<T>): void {
  behaviorSettingRegistry.register(def);
}

// --- Deploy (board self-deploy smoke parameters) ---------------------------

register({
  key: "system.deploy.enabled",
  envName: "MYRMIDON_DEPLOY_ENABLED",
  default: false,
  scope: "instance",
  section: "system",
  valueType: "boolean",
  validate: validateBoolean,
});

register({
  key: "system.deploy.autoRollback",
  envName: "MYRMIDON_DEPLOY_AUTO_ROLLBACK",
  default: true,
  scope: "instance",
  section: "system",
  valueType: "boolean",
  validate: validateBoolean,
});

register({
  key: "system.deploy.autoUpdate",
  envName: "MYRMIDON_DEPLOY_AUTO_UPDATE",
  default: false,
  scope: "instance",
  section: "system",
  valueType: "boolean",
  validate: validateBoolean,
});

register({
  key: "system.deploy.verifyTimeoutSec",
  envName: "MYRMIDON_DEPLOY_VERIFY_TIMEOUT_SEC",
  default: 30,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(1, 300),
});

register({
  key: "system.deploy.tickSec",
  envName: "MYRMIDON_DEPLOY_TICK_SEC",
  default: 5,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(1, 3600),
});

register({
  key: "system.deploy.stepTimeoutSec",
  envName: "MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC",
  default: 1800,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(10, 86400),
});

register({
  key: "system.deploy.healthPollSec",
  envName: "MYRMIDON_DEPLOY_HEALTH_POLL_SEC",
  default: 5,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(1, 300),
});

register({
  key: "system.deploy.healthTimeoutSec",
  envName: "MYRMIDON_DEPLOY_HEALTH_TIMEOUT_SEC",
  default: 300,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(10, 3600),
});

// --- Tracing health (LLM pipeline signal) ----------------------------------

register({
  key: "system.tracing.windowSec",
  envName: "MYRMIDON_TRACING_WINDOW_SEC",
  default: 900,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(60, 3600),
});

register({
  key: "system.tracing.healthTtlSec",
  envName: "MYRMIDON_TRACING_HEALTH_TTL_SEC",
  default: 60,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(5, 3600),
});

register({
  key: "system.tracing.signalIntervalSec",
  envName: "MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC",
  default: 300,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(30, 86400),
});

// --- Zabbix (maintenance windows) ------------------------------------------
register({
  key: "system.zabbix.hostGroups",
  envName: "MYRMIDON_ZABBIX_HOST_GROUPS",
  default: [] as string[],
  scope: "instance",
  section: "system",
  valueType: "json",
  validate: validateStringList,
});

register({
  key: "system.zabbix.maxWindowSec",
  envName: "MYRMIDON_ZABBIX_MAX_WINDOW_SEC",
  default: 14_400,
  scope: "instance",
  section: "system",
  valueType: "number",
  validate: validateIntRange(60, 604800),
});

// --- Hindsight (agent memory service) ---------------------------------------
//
// Note: the hindsight settings (address, enabled flag, key secret name)
// already live in `instance_settings.general.agentMemory`
// (myrmidon-agent-memory.ts) with live re-read on every request and a
// secrets-store picker in the UI. They are deliberately NOT duplicated in this
// registry — one source of truth per setting. myrmidon(1.7, OPE-4101)

/** Keys of this section, for tests and consumers. */
export const SYSTEM_SETTING_KEYS = [
  "system.deploy.enabled",
  "system.deploy.autoRollback",
  "system.deploy.autoUpdate",
  "system.deploy.verifyTimeoutSec",
  "system.deploy.tickSec",
  "system.deploy.stepTimeoutSec",
  "system.deploy.healthPollSec",
  "system.deploy.healthTimeoutSec",
  "system.tracing.windowSec",
  "system.tracing.healthTtlSec",
  "system.tracing.signalIntervalSec",
  "system.zabbix.hostGroups",
  "system.zabbix.maxWindowSec",
] as const;

export type SystemSettingKey = (typeof SYSTEM_SETTING_KEYS)[number];
