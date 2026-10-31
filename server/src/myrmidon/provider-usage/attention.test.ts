import { describe, expect, it } from "vitest";
import { buildProviderUsageAttentionCard } from "./attention.js";

describe("provider usage attention card", () => {
  it("builds a warning card before the provider reset", () => {
    const card = buildProviderUsageAttentionCard({ key: "k", provider: "p", credentialRef: "opaque", window: "package", observedAt: "2026-10-14T00:00:00Z", resetsAt: "2026-10-29T00:00:00Z", thresholdPercent: 80, metric: "tokens", used: 850, limit: 1000, remaining: 150, remainingPercent: 15, trigger: "usage", usedPercent: 85, elapsedPercent: 40 });
    expect(card.dedupKey).toBe("provider-usage:k");
    expect(card.severity).toBe("medium");
    expect(card.whyNow).toContain("used 85%");
    expect(card.whyNow).toContain("150 of 1000 remains");
  });

  it("does not claim consumption when the time threshold fired", () => {
    const card = buildProviderUsageAttentionCard({ key: "k2", provider: "p", credentialRef: "opaque", window: "rolling_5h", observedAt: "2026-10-14T09:00:00Z", resetsAt: "2026-10-14T10:00:00Z", thresholdPercent: 80, metric: "requests", used: 1, limit: 100, remaining: 99, remainingPercent: 99, trigger: "time", usedPercent: 1, elapsedPercent: 80 });
    expect(card.whyNow).toContain("80% of the window has elapsed");
    expect(card.whyNow).toContain("used 1% so far");
    expect(card.whyNow).not.toMatch(/used 80%|reached 80%/);
  });
});
