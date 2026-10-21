import { z } from "zod";

export const PROVIDER_USAGE_WARNING_THRESHOLD_SETTING = "providerUsageWarningThresholdPercent";
export const DEFAULT_PROVIDER_USAGE_WARNING_THRESHOLD_PERCENT = 80;
export const validateProviderUsageWarningThresholdSchema = z.number().finite().gt(0).lt(100);
export const updateProviderUsageWarningThresholdSchema = z.object({
  thresholdPercent: validateProviderUsageWarningThresholdSchema,
}).strict();

export function resolveProviderUsageWarningThreshold(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return validateProviderUsageWarningThresholdSchema.safeParse(parsed).success
    ? parsed
    : DEFAULT_PROVIDER_USAGE_WARNING_THRESHOLD_PERCENT;
}
