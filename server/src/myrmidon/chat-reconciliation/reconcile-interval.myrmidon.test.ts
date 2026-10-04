// myrmidon(D1): pure unit test for getChatReconcileFallbackIntervalMs. See
// docs/myrmidon/DIVERGENCE.md.
import { describe, expect, it } from "vitest";
import { getChatReconcileFallbackIntervalMs } from "./reconcile-interval.js";

describe("getChatReconcileFallbackIntervalMs", () => {
  it("uses default 30 seconds when not set", () => {
    expect(getChatReconcileFallbackIntervalMs({})).toBe(30_000);
    expect(getChatReconcileFallbackIntervalMs({ MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS: undefined })).toBe(30_000);
  });

  it("parses a positive value", () => {
    expect(
      getChatReconcileFallbackIntervalMs({ MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS: "45000" }),
    ).toBe(45000);
  });

  it("falls back to default for zero, negative, and unparseable values", () => {
    expect(getChatReconcileFallbackIntervalMs({ MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS: "0" })).toBe(30_000);
    expect(getChatReconcileFallbackIntervalMs({ MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS: "-1" })).toBe(30_000);
    expect(getChatReconcileFallbackIntervalMs({ MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS: "nope" })).toBe(30_000);
  });
});
