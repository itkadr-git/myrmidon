// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): tests for manual update check schemas and semver helpers
import { describe, expect, it } from "vitest";
import {
  checkUpdatesRequestSchema,
  checkUpdatesResponseSchema,
  compareSemver,
  evaluateUpdateAvailability,
  isNewerVersion,
  normalizeVersionString,
} from "./myrmidon-check-updates.js";

describe("myrmidon-check-updates", () => {
  describe("normalizeVersionString", () => {
    it("strips prefixes correctly", () => {
      expect(normalizeVersionString("myr-v1.7.0")).toBe("1.7.0");
      expect(normalizeVersionString("myr-1.7.0")).toBe("1.7.0");
      expect(normalizeVersionString("v1.7.0")).toBe("1.7.0");
      expect(normalizeVersionString("1.7.0")).toBe("1.7.0");
    });
  });

  describe("compareSemver and isNewerVersion", () => {
    it("compares basic versions correctly", () => {
      expect(compareSemver("1.7.0", "1.6.6")).toBe(1);
      expect(compareSemver("1.6.6", "1.7.0")).toBe(-1);
      expect(compareSemver("1.7.0", "1.7.0")).toBe(0);
      expect(isNewerVersion("1.6.6", "1.7.0")).toBe(true);
      expect(isNewerVersion("1.7.0", "1.6.6")).toBe(false);
    });

    it("handles pre-releases per semver spec", () => {
      expect(compareSemver("1.7.0", "1.7.0-rc.1")).toBe(1);
      expect(compareSemver("1.7.0-rc.1", "1.7.0")).toBe(-1);
      expect(compareSemver("1.7.0-rc.2", "1.7.0-rc.1")).toBe(1);
      expect(compareSemver("1.7.0-rc.1", "1.7.0-rc.2")).toBe(-1);
      expect(isNewerVersion("1.7.0-rc.1", "1.7.0-rc.2")).toBe(true);
      expect(isNewerVersion("1.7.0-rc.1", "1.7.0")).toBe(true);
    });

    it("handles build metadata and prefixes", () => {
      expect(compareSemver("myr-v1.7.0+build.1", "v1.6.6+build.2")).toBe(1);
      expect(compareSemver("myr-v1.7.0", "1.7.0")).toBe(0);
    });
  });

  describe("evaluateUpdateAvailability", () => {
    it("detects update when candidate is newer version", () => {
      expect(
        evaluateUpdateAvailability({ version: "1.6.6" }, { version: "1.7.0" }),
      ).toBe(true);
      expect(
        evaluateUpdateAvailability({ version: "1.7.0" }, { version: "1.6.6" }),
      ).toBe(false);
    });

    it("detects update when same version but digest differs", () => {
      expect(
        evaluateUpdateAvailability(
          { version: "1.7.0", digest: "sha256:aaa" },
          { version: "1.7.0", digest: "sha256:bbb" },
        ),
      ).toBe(true);
      expect(
        evaluateUpdateAvailability(
          { version: "1.7.0", digest: "sha256:aaa" },
          { version: "1.7.0", digest: "sha256:aaa" },
        ),
      ).toBe(false);
    });

    it("detects update when same version but commit differs", () => {
      expect(
        evaluateUpdateAvailability(
          { version: "1.7.0", commit: "abcdef1" },
          { version: "1.7.0", commit: "abcdef2" },
        ),
      ).toBe(true);
    });
  });

  describe("request and response validation", () => {
    it("validates request schema with defaults", () => {
      const parsed = checkUpdatesRequestSchema.parse({});
      expect(parsed).toEqual({
        channel: "stable",
        force: false,
      });
    });

    it("accepts valid request parameters", () => {
      const parsed = checkUpdatesRequestSchema.parse({
        channel: "canary",
        force: true,
        reference: "ghcr.io/itkadr-git/myrmidon:latest",
      });
      expect(parsed.channel).toBe("canary");
      expect(parsed.force).toBe(true);
      expect(parsed.reference).toBe("ghcr.io/itkadr-git/myrmidon:latest");
    });

    it("rejects unknown properties in request", () => {
      expect(() =>
        checkUpdatesRequestSchema.parse({
          channel: "stable",
          unknownField: true,
        }),
      ).toThrow();
    });

    it("rejects invalid channel", () => {
      expect(() =>
        checkUpdatesRequestSchema.parse({
          channel: "experimental",
        }),
      ).toThrow();
    });

    it("validates response schema", () => {
      const valid = checkUpdatesResponseSchema.parse({
        currentVersion: "1.6.6",
        currentCommit: "0123456",
        currentDigest: "sha256:abc",
        channel: "stable",
        updateAvailable: true,
        latestVersion: "1.7.0",
        latestCommit: "7890123",
        latestDigest: "sha256:def",
        releaseTag: "myr-v1.7.0",
        releaseUrl: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0",
        releaseNotes: "Release notes for 1.7.0",
        publishedAt: "2026-10-30T12:00:00Z",
        checkedAt: "2026-10-31T00:00:00Z",
        error: null,
      });
      expect(valid.updateAvailable).toBe(true);
    });
  });
});
