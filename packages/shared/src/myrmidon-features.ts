// myrmidon(FEATURES): the shared contract of the Instance -> Features page.
//
// Every fork feature is a registry entry with a name, a docs link, the way to
// read its effective config (value + where it came from) and a health report
// the operator can read without opening logs. The server computes the report
// (server/src/myrmidon/features/), the board UI renders it.
//
// The report never claims "working" without a signal: a feature whose module
// has no health signal yet is reported as `unknown`, with a reason that says so.

/** The statuses of a feature's health, in the order the UI sorts attention first. */
export const FEATURE_HEALTH_STATUSES = ["failing", "misconfigured", "unknown", "working", "off"] as const;
export type FeatureHealthStatus = (typeof FEATURE_HEALTH_STATUSES)[number];

/** Where an effective config value came from. `derived` is computed from other values. */
export type FeatureConfigSource = "settings" | "env" | "default" | "derived";

/** How long a feature must stay enabled-and-broken before it raises an attention card. */
export const FEATURE_ATTENTION_AFTER_MS = 30 * 60_000;

/** The window the error count and the effect metric are read over. */
export const FEATURE_HEALTH_WINDOW_MS = 24 * 60 * 60_000;

/** The reason text of a feature that has no health signal. */
export const FEATURE_NO_HEALTH_SIGNAL_REASON = "unknown — no health signal";

export interface FeatureConfigEntry {
  /** Short label, e.g. "Lease TTL". */
  label: string;
  /** The effective value as text; secrets are never put here, only "set" / "not set". */
  value: string;
  source: FeatureConfigSource;
  /** The environment variable that can force the value, when there is one. */
  envVar?: string;
}

export interface FeatureHealth {
  status: FeatureHealthStatus;
  /** One sentence for the operator: why the status is what it is. */
  reason: string;
  /** Last time the feature did its job successfully, or null when not known. */
  lastSuccessAt: string | null;
  lastError: { at: string | null; message: string } | null;
  /** Errors over the last 24 hours; null when the module cannot count them. */
  errors24h: number | null;
  /** The one number that shows the feature has an effect, e.g. "issues claimed in 24 h". */
  effect: { label: string; value: number | null; unit?: string } | null;
}

export interface FeatureSettingsLink {
  /** Board path of the page that holds the panel. */
  path: string;
  /** Title of the panel on that page. */
  panel: string;
}

export interface FeatureToggle {
  enabled: boolean;
  /** `env` when an environment variable forces the value, so the toggle cannot change it. */
  lockedBy: "env" | null;
}

export interface FeatureView {
  key: string;
  name: string;
  description: string;
  /** Path of the guide in the repository, relative to the repository root. */
  docs: string;
  /** Whether the feature is switched on by its own setting; null when it has no switch. */
  enabled: boolean | null;
  config: FeatureConfigEntry[];
  settings: FeatureSettingsLink | null;
  /** Present when the feature is a simple on/off the page can flip inline. */
  toggle: FeatureToggle | null;
  health: FeatureHealth;
  /** ISO time since which the feature has been enabled-and-broken, or null. */
  needsAttentionSince: string | null;
}

export interface FeaturesReport {
  checkedAt: string;
  features: FeatureView[];
  summary: Record<FeatureHealthStatus, number>;
}

/** Body of `PATCH /api/myrmidon/features/:key`. */
export interface FeatureTogglePatch {
  enabled: boolean;
}

/** True for the two statuses that mean an enabled feature is not doing its job. */
export function isFeatureBroken(status: FeatureHealthStatus): boolean {
  return status === "failing" || status === "misconfigured";
}
