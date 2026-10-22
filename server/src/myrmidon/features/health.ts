// myrmidon(FEATURES): small constructors the definitions share, so every
// module words its health the same way.

import {
  FEATURE_NO_HEALTH_SIGNAL_REASON,
  type FeatureConfigEntry,
  type FeatureConfigSource,
  type FeatureHealth,
  type FeatureHealthStatus,
} from "@paperclipai/shared";
import type { OutcomeSummary } from "./recorder.js";

export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** The later of two optional dates. */
export function latestOf(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date && (!best || date.getTime() > best.getTime())) best = date;
  }
  return best;
}

export function makeHealth(
  status: FeatureHealthStatus,
  reason: string,
  extra: Partial<Omit<FeatureHealth, "status" | "reason">> = {},
): FeatureHealth {
  return {
    status,
    reason,
    lastSuccessAt: null,
    lastError: null,
    errors24h: null,
    effect: null,
    ...extra,
  };
}

export function healthOff(reason: string): FeatureHealth {
  return makeHealth("off", reason);
}

/**
 * A module with no health signal. Never "working": the page says plainly that
 * nobody can tell. `detail` adds what is known (for example the config facts).
 */
export function healthUnknown(detail?: string, extra: Partial<Omit<FeatureHealth, "status" | "reason">> = {}): FeatureHealth {
  return makeHealth(
    "unknown",
    detail ? `${FEATURE_NO_HEALTH_SIGNAL_REASON}: ${detail}` : FEATURE_NO_HEALTH_SIGNAL_REASON,
    extra,
  );
}

/** The error half of a health report, from the recorder. */
export function errorFields(summary: OutcomeSummary): Pick<FeatureHealth, "lastError" | "errors24h"> {
  return {
    errors24h: summary.errors24h,
    lastError: summary.lastError ? { at: iso(summary.lastErrorAt), message: summary.lastError } : null,
  };
}

export function entry(
  label: string,
  value: string | number | boolean | null | undefined,
  source: FeatureConfigSource,
  envVar?: string,
): FeatureConfigEntry {
  const text = value === null || value === undefined || value === "" ? "not set" : String(value);
  return envVar ? { label, value: text, source, envVar } : { label, value: text, source };
}

export function listText(values: readonly string[], whenEmpty: string): string {
  return values.length > 0 ? values.join(", ") : whenEmpty;
}

/** Whether an environment variable holds an explicit on/off value. */
export function parseFlag(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

export function envIsSet(env: Record<string, string | undefined>, name: string): boolean {
  return Boolean(env[name]?.trim());
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
