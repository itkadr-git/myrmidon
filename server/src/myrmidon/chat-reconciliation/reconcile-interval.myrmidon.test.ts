// myrmidon(D1): pure unit test for getChatReconcileFallbackIntervalMs. See
// docs/myrmidon/DIVERGENCE.md.
import { describe, expect, it } from "vitest";
import { chatReconcileMinimumSpacingMs, getChatReconcileFallbackIntervalMs } from "./reconcile-interval.js";

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

describe("chatReconcileMinimumSpacingMs", () => {
  it("is unset by default, leaving today's spacing untouched", () => {
    expect(chatReconcileMinimumSpacingMs({})).toBeUndefined();
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: undefined })).toBeUndefined();
  });

  it("parses a positive value", () => {
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "15000" })).toBe(15000);
  });

  it("ignores zero, negative, and unparseable values", () => {
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "0" })).toBeUndefined();
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "-1" })).toBeUndefined();
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "nope" })).toBeUndefined();
  });
});
