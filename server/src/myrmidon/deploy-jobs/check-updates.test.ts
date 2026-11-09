// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): tests for the manual update check domain service
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSystemUpdates, clearCheckUpdatesCache } from "./check-updates.js";

const buildInfo = () => ({
  version: "1.6.6",
  commit: "0123456",
  imageDigest: "sha256:current",
});

describe("checkSystemUpdates (domain service)", () => {
  beforeEach(() => {
    clearCheckUpdatesCache();
  });

  afterEach(() => {
    clearCheckUpdatesCache();
  });

  it("stable channel: detects a newer release as available", async () => {
    const fetchJson = async () => ({
      tag_name: "myr-v1.7.0",
      html_url: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0",
      body: "New release 1.7.0",
      published_at: "2026-10-31T00:00:00Z",
    });

    const result = await checkSystemUpdates(
      { channel: "stable", force: true },
      { buildInfo, fetchJson },
    );

    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe("1.6.6");
    expect(result.latestVersion).toBe("1.7.0");
    expect(result.channel).toBe("stable");
    expect(result.releaseTag).toBe("myr-v1.7.0");
    expect(result.error).toBeNull();
  });

  it("stable channel: up to date when the latest release matches current", async () => {
    const fetchJson = async () => ({
      tag_name: "myr-v1.6.6",
      html_url: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.6.6",
      body: "Current release",
      published_at: "2026-10-01T00:00:00Z",
    });

    const result = await checkSystemUpdates(
      { channel: "stable", force: true },
      { buildInfo, fetchJson },
    );

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe("1.6.6");
  });

  it("rc channel: picks the newest release including pre-releases", async () => {
    const fetchJson = async () => [
      {
        tag_name: "myr-v1.7.0-rc.1",
        html_url: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0-rc.1",
        body: "Release candidate 1",
        published_at: "2026-10-30T12:00:00Z",
      },
      {
        tag_name: "myr-v1.6.6",
        html_url: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.6.6",
        body: "Current release",
        published_at: "2026-10-01T00:00:00Z",
      },
    ];

    const result = await checkSystemUpdates(
      { channel: "rc", force: true },
      { buildInfo, fetchJson },
    );

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("1.7.0-rc.1");
    expect(result.channel).toBe("rc");
  });

  it("canary channel: compares against the latest main commit", async () => {
    const fetchJson = async () => ({
      sha: "9999999abcdef0123456789abcdef01234567",
      html_url: "https://github.com/itkadr-git/myrmidon/commit/9999999",
      commit: {
        message: "feat: new commit on main",
        author: { date: "2026-10-31T05:00:00Z" },
      },
    });

    const result = await checkSystemUpdates(
      { channel: "canary", force: true },
      { buildInfo, fetchJson },
    );

    expect(result.updateAvailable).toBe(true);
    expect(result.latestCommit).toContain("9999999");
    expect(result.channel).toBe("canary");
  });

  it("reference: normalizes a myr-v tag out of a full image reference", async () => {
    const fetchJson = async () => {
      throw new Error("must not be called for reference checks");
    };

    const result = await checkSystemUpdates(
      { reference: "ghcr.io/itkadr-git/myrmidon:myr-v1.7.0", force: true },
      { buildInfo, fetchJson },
    );

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("1.7.0");
    expect(result.releaseTag).toBe("myr-v1.7.0");
  });

  it("returns a check error message instead of throwing when upstream fails", async () => {
    const fetchJson = async () => {
      throw new Error("Upstream request failed (503)");
    };

    const result = await checkSystemUpdates(
      { channel: "stable", force: true },
      { buildInfo, fetchJson },
    );

    expect(result.error).toContain("Upstream request failed (503)");
    expect(result.updateAvailable).toBe(false);
  });

  it("serves a fresh non-forced check from cache without hitting upstream", async () => {
    const calls: string[] = [];
    const fetchJson = async (url: string) => {
      calls.push(url);
      return { tag_name: "myr-v1.7.0" };
    };

    const first = await checkSystemUpdates(
      { channel: "stable" },
      { buildInfo, fetchJson },
    );
    const second = await checkSystemUpdates(
      { channel: "stable" },
      { buildInfo, fetchJson },
    );

    expect(calls).toHaveLength(1);
    expect(second.latestVersion).toBe(first.latestVersion);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it("throws a validation error for an invalid channel", async () => {
    await expect(
      checkSystemUpdates(
        { channel: "experimental" as never, force: true },
        { buildInfo, fetchJson: async () => ({}) },
      ),
    ).rejects.toThrow();
  });
});
