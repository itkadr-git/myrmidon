// myrmidon(OPE-7202): `instance_settings.general.providerUsageWarningThresholdPercent`
// is written by the provider-usage route, not by the vendor settings schema, so a
// vendor write of `general` would drop it. Keep the stored value across such writes —
// the same contract every other myrmidon general key follows.
import { PROVIDER_USAGE_WARNING_THRESHOLD_SETTING } from "@paperclipai/shared";

export function preserveProviderUsageThresholdGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null || Array.isArray(storedGeneral)) return {};
  const value = (storedGeneral as Record<string, unknown>)[PROVIDER_USAGE_WARNING_THRESHOLD_SETTING];
  return value === undefined ? {} : { [PROVIDER_USAGE_WARNING_THRESHOLD_SETTING]: value };
}
