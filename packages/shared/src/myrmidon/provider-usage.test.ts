import { describe, expect, it } from "vitest";
import { describeProviderUsageWarning, evaluateProviderUsageWarning, aggregateProviderUsageReports, type ProviderUsageReportedEventV1 } from "./provider-usage.js";
import { resolveProviderUsageWarningThreshold, updateProviderUsageWarningThresholdSchema, withProviderUsageWarningThreshold } from "./provider-usage-settings.js";

const report: ProviderUsageReportedEventV1 = {
  schemaVersion: 1,
  companyId: "00000000-0000-4000-8000-000000000001",
  eventId: "evt-1",
  ownerIssueId: "OPE-1",
  provider: "provider-test",
  credentialRef: "credential-opaque-test",
  observedAt: "2026-10-14T09:00:00Z",
  window: { kind: "rolling_5h", startedAt: "2026-10-14T05:00:00Z", resetsAt: "2026-10-14T10:00:00Z", used: { requests: 80, tokens: 800 }, limit: { requests: 100, tokens: 1000 } },
};

describe("provider usage", () => {
  it("validates configurable thresholds within the open interval", () => {
    expect(updateProviderUsageWarningThresholdSchema.safeParse({ thresholdPercent: 80 }).success).toBe(true);
    expect(updateProviderUsageWarningThresholdSchema.safeParse({ thresholdPercent: 0 }).success).toBe(false);
    expect(updateProviderUsageWarningThresholdSchema.safeParse({ thresholdPercent: 100 }).success).toBe(false);
  });

  it("warns when threshold is crossed before reset", () => {
    expect(evaluateProviderUsageWarning(report, 80)).toMatchObject({ metric: "requests", remaining: 20 });
    expect(evaluateProviderUsageWarning({ ...report, observedAt: "2026-10-14T08:00:00Z", window: { ...report.window, used: { requests: 80 } } }, 80)).not.toBeNull();
  });
  it("aggregates strictly before reset, excludes reset-time and stale reports", () => {
    const atReset = { ...report, eventId: "evt-reset", observedAt: report.window.resetsAt };
    const stale = { ...report, eventId: "evt-stale", observedAt: "2026-10-14T08:30:00Z" };
    expect(aggregateProviderUsageReports([report, atReset])).toHaveLength(0);
    expect(aggregateProviderUsageReports([report, stale])).toHaveLength(1);
    expect(aggregateProviderUsageReports([report, stale])[0]?.observedAt).toBe(report.observedAt);
  });
  it("does not warn below the configured threshold", () => {
    expect(evaluateProviderUsageWarning({ ...report, observedAt: "2026-10-14T06:00:00Z", window: { ...report.window, used: { requests: 79 } } }, 80)).toBeNull();
  });
  it("reevaluates a stale snapshot as the window approaches reset", () => {
    const snapshot = { ...report, observedAt: "2026-10-14T05:01:00Z", window: { ...report.window, used: { requests: 1 } } };
    expect(evaluateProviderUsageWarning(snapshot, 80, "", "2026-10-14T08:30:00Z")).toBeNull();
    expect(evaluateProviderUsageWarning(snapshot, 80, "", "2026-10-14T09:00:00Z")).toMatchObject({
      metric: "requests",
      observedAt: "2026-10-14T09:00:00.000Z",
    });
  });
  it("tells a time-triggered warning from a usage-triggered one", () => {
    const low = { ...report, observedAt: "2026-10-14T05:01:00Z", window: { ...report.window, used: { requests: 1 }, limit: { requests: 100 } } };
    const byTime = evaluateProviderUsageWarning(low, 80, "", "2026-10-14T09:00:00Z");
    expect(byTime).toMatchObject({ trigger: "time", usedPercent: 1, elapsedPercent: 80 });
    expect(describeProviderUsageWarning(byTime!)).toContain("80% of the window has elapsed");
    expect(describeProviderUsageWarning(byTime!)).not.toContain("used 80%");
    const byUsage = evaluateProviderUsageWarning(report, 80)!;
    expect(byUsage.trigger).toBe("usage");
    expect(describeProviderUsageWarning(byUsage)).toContain("used 80%");
  });
  it("does not warn at or after the reset", () => {
    expect(evaluateProviderUsageWarning({ ...report, observedAt: report.window.resetsAt }, 80)).toBeNull();
    expect(evaluateProviderUsageWarning({ ...report, observedAt: "2026-10-14T11:00:00Z" }, 80)).toBeNull();
  });
  it("keeps separate periods and selects the newest report per period", () => {
    const newer = { ...report, eventId: "evt-2", observedAt: "2026-10-14T09:30:00Z", window: { ...report.window, used: { requests: 90 } } };
    const next = { ...report, eventId: "evt-3", window: { ...report.window, startedAt: report.window.resetsAt, resetsAt: "2026-10-14T15:00:00Z" } };
    expect(aggregateProviderUsageReports([report, newer, newer])).toHaveLength(1);
    expect(aggregateProviderUsageReports([report, next])).toHaveLength(2);
    expect(aggregateProviderUsageReports([report, newer])[0]?.used.requests).toBe(90);
  });
  it("scopes the warning threshold to the company", () => {
    const stored = withProviderUsageWarningThreshold(undefined, "company-a", 60);
    expect(resolveProviderUsageWarningThreshold(stored, "company-a")).toBe(60);
    expect(resolveProviderUsageWarningThreshold(stored, "company-b")).toBe(80);
    const both = withProviderUsageWarningThreshold(stored, "company-b", 90);
    expect(resolveProviderUsageWarningThreshold(both, "company-a")).toBe(60);
    expect(resolveProviderUsageWarningThreshold(both, "company-b")).toBe(90);
  });
  it("keeps a legacy instance-wide number as the default for other companies", () => {
    expect(resolveProviderUsageWarningThreshold(70, "company-a")).toBe(70);
    const migrated = withProviderUsageWarningThreshold(70, "company-a", 50);
    expect(resolveProviderUsageWarningThreshold(migrated, "company-a")).toBe(50);
    expect(resolveProviderUsageWarningThreshold(migrated, "company-b")).toBe(70);
  });
});
