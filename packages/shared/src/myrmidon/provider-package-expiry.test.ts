// packages/shared/src/myrmidon/provider-package-expiry.test.ts

import { describe, expect, it } from "vitest";
import {
  calculatePackageExpiration,
  describeModelProviderPackageWarning,
  evaluateModelProviderPackageWarning,
} from "./provider-package-expiry.js";

describe("myrmidon(1.6.6) provider package expiry calculation & monitoring", () => {
  describe("calculatePackageExpiration", () => {
    it("calculates exact expiration for a 15-day package (e.g. nghimmo)", () => {
      const startedAt = "2026-10-01T00:00:00.000Z";
      const { expiresAt, durationMs } = calculatePackageExpiration({
        startedAt,
        durationDays: 15,
      });

      expect(durationMs).toBe(15 * 24 * 60 * 60 * 1000);
      expect(expiresAt.toISOString()).toBe("2026-10-16T00:00:00.000Z");
    });

    it("rejects non-positive duration days", () => {
      expect(() =>
        calculatePackageExpiration({
          startedAt: "2026-10-01T00:00:00.000Z",
          durationDays: 0,
        }),
      ).toThrow(RangeError);

      expect(() =>
        calculatePackageExpiration({
          startedAt: "2026-10-01T00:00:00.000Z",
          durationDays: -5,
        }),
      ).toThrow(RangeError);
    });

    it("rejects invalid date string", () => {
      expect(() =>
        calculatePackageExpiration({
          startedAt: "invalid-date",
          durationDays: 15,
        }),
      ).toThrow(TypeError);
    });
  });

  describe("evaluateModelProviderPackageWarning", () => {
    const provider = {
      id: "prov-nghimmo-1",
      name: "nghimmo-main",
      packageName: "nghimmo-15d",
      createdAt: "2026-10-01T00:00:00.000Z",
      keyValidatedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-16T00:00:00.000Z",
      rpmLimit: 120,
    };

    it("validates threshold percentage bounds", () => {
      expect(() =>
        evaluateModelProviderPackageWarning(provider, { thresholdPercent: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        evaluateModelProviderPackageWarning(provider, { thresholdPercent: 100 }),
      ).toThrow(RangeError);
      expect(() =>
        evaluateModelProviderPackageWarning(provider, { thresholdPercent: -10 }),
      ).toThrow(RangeError);
    });

    it("returns null when package period has not reached threshold", () => {
      // Day 5 out of 15 (~33% elapsed)
      const warning = evaluateModelProviderPackageWarning(provider, {
        now: "2026-10-06T00:00:00.000Z",
        thresholdPercent: 80,
      });
      expect(warning).toBeNull();
    });

    it("warns when package period reaches warning threshold (80% elapsed, 3 days remaining)", () => {
      // Day 12 out of 15 (exact 80% elapsed, 3 days remain before 2026-10-16)
      const warning = evaluateModelProviderPackageWarning(provider, {
        now: "2026-10-13T00:00:00.000Z",
        thresholdPercent: 80,
      });

      expect(warning).not.toBeNull();
      expect(warning).toMatchObject({
        providerId: "prov-nghimmo-1",
        providerName: "nghimmo-main",
        packageName: "nghimmo-15d",
        trigger: "time",
        status: "warning",
        thresholdPercent: 80,
        remainingDays: 3,
        elapsedPercent: 80,
      });
      expect(warning?.message).toContain("80% of period has elapsed");
      expect(warning?.message).toContain("3 days remaining");
      expect(describeModelProviderPackageWarning(warning!)).toBe(warning?.message);
    });

    it("detects expired package when now is past expiresAt", () => {
      const warning = evaluateModelProviderPackageWarning(provider, {
        now: "2026-10-16T12:00:00.000Z",
        thresholdPercent: 80,
      });

      expect(warning).not.toBeNull();
      expect(warning).toMatchObject({
        providerId: "prov-nghimmo-1",
        trigger: "expired",
        status: "expired",
        remainingDays: 0,
        elapsedPercent: 100,
      });
      expect(warning?.message).toContain("expired at 2026-10-16T00:00:00.000Z");
    });

    it("warns when RPM consumption approaches rpmLimit", () => {
      const warning = evaluateModelProviderPackageWarning(
        {
          id: "prov-rpm-1",
          name: "custom-llm",
          rpmLimit: 100,
        },
        {
          currentRpm: 85,
          thresholdPercent: 80,
        },
      );

      expect(warning).not.toBeNull();
      expect(warning).toMatchObject({
        providerId: "prov-rpm-1",
        trigger: "limit",
        status: "warning",
        rpmLimit: 100,
        currentRpm: 85,
      });
      expect(warning?.message).toContain("85% of its RPM limit");
      expect(warning?.message).toContain("85 of 100 rpm");
    });

    it("returns null when provider has no expiration date and RPM is below threshold", () => {
      const warning = evaluateModelProviderPackageWarning(
        {
          id: "prov-no-limits",
          name: "unlimited",
        },
        {
          currentRpm: 20,
        },
      );
      expect(warning).toBeNull();
    });
  });
});
