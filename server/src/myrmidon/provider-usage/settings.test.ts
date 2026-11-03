import { describe, expect, it } from "vitest";
import { PROVIDER_USAGE_WARNING_THRESHOLD_SETTING } from "@myrmidon/shared";
import { preserveProviderUsageThresholdGeneralKey } from "./settings.js";

describe("preserveProviderUsageThresholdGeneralKey", () => {
  it("restores the stored per-company threshold map over a vendor write", () => {
    const stored = { [PROVIDER_USAGE_WARNING_THRESHOLD_SETTING]: { "company-a": 60 }, censorUsernameInLogs: false };
    const vendorWrite = { censorUsernameInLogs: true, ...preserveProviderUsageThresholdGeneralKey(stored) };
    expect(vendorWrite).toEqual({ censorUsernameInLogs: true, [PROVIDER_USAGE_WARNING_THRESHOLD_SETTING]: { "company-a": 60 } });
  });
  it("adds nothing when the key was never set or general is malformed", () => {
    expect(preserveProviderUsageThresholdGeneralKey({})).toEqual({});
    expect(preserveProviderUsageThresholdGeneralKey(null)).toEqual({});
    expect(preserveProviderUsageThresholdGeneralKey([1])).toEqual({});
  });
});
