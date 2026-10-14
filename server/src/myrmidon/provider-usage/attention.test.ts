import { describe, expect, it } from "vitest";
import { buildProviderUsageAttentionCard } from "./attention.js";

describe("provider usage attention card", () => {
  it("builds a warning card before the provider reset", () => {
    const card = buildProviderUsageAttentionCard({ key: "k", provider: "p", credentialRef: "opaque", window: "package", observedAt: "2026-10-14T00:00:00Z", resetsAt: "2026-10-29T00:00:00Z", thresholdPercent: 80, metric: "tokens", used: 850, limit: 1000, remaining: 150, remainingPercent: 15 });
    expect(card.dedupKey).toBe("provider-usage:k");
    expect(card.severity).toBe("medium");
    expect(card.whyNow).toContain("150 remains");
  });
});
