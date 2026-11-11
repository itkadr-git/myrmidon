import { z } from "zod";

export const PROVIDER_USAGE_WARNING_THRESHOLD_SETTING = "providerUsageWarningThresholdPercent";
export const DEFAULT_PROVIDER_USAGE_WARNING_THRESHOLD_PERCENT = 80;
export const validateProviderUsageWarningThresholdSchema = z.number().finite().gt(0).lt(100);
export const updateProviderUsageWarningThresholdSchema = z.object({
  thresholdPercent: validateProviderUsageWarningThresholdSchema,
}).strict();

function parseThreshold(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return validateProviderUsageWarningThresholdSchema.safeParse(parsed).success ? parsed : null;
}

/**
 * The setting lives in instance settings but is scoped per company:
 * `{ [companyId]: percent }`; key "*" is the instance-wide default. A bare number (older format)
 * is read as that default.
 */
export function resolveProviderUsageWarningThreshold(value: unknown, companyId?: string): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    const own = companyId ? parseThreshold(map[companyId]) : null;
    return own ?? parseThreshold(map["*"]) ?? DEFAULT_PROVIDER_USAGE_WARNING_THRESHOLD_PERCENT;
  }
  return parseThreshold(value) ?? DEFAULT_PROVIDER_USAGE_WARNING_THRESHOLD_PERCENT;
}

/** Returns the stored setting value with only `companyId`'s threshold changed. */
export function withProviderUsageWarningThreshold(current: unknown, companyId: string, percent: number): Record<string, number> {
  const next: Record<string, number> = {};
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      const parsed = parseThreshold(value);
      if (parsed !== null) next[key] = parsed;
    }
  }
  else {
    const legacy = parseThreshold(current);
    if (legacy !== null) next["*"] = legacy;
  }
  next[companyId] = percent;
  return next;
}
