import { describe, expect, it, vi } from "vitest";
import {
  buildDraftTaskSummary,
  createDefaultGitHubClient,
  InMemoryIssueSink,
  normaliseVersion,
  readReleaseReconciliationConfig,
  reconcileReleases,
  ReleaseReconciliationService,
  type GitHubClient,
  type GitHubReleaseInfo,
  type GitHubTagInfo,
} from "./index.js";

describe("release-reconciliation unit tests", () => {
  describe("normaliseVersion", () => {
    it("strips prefixes, tags and image repo qualifiers", () => {
      expect(normaliseVersion("v1.6.5")).toBe("1.6.5");
      expect(normaliseVersion("V2.0.0-rc.1")).toBe("2.0.0-rc.1");
      expect(normaliseVersion("ghcr.io/paperclipai/paperclip:v1.6.5")).toBe("1.6.5");
      expect(normaliseVersion("  1.7.0  ")).toBe("1.7.0");
    });
  });

  describe("readReleaseReconciliationConfig", () => {
    it("reads configuration from environment with defaults", () => {
      const config = readReleaseReconciliationConfig({});
      expect(config.vendorRepo).toBe("paperclipai/paperclip");
      expect(config.gitHubApiBase).toBe("https://api.github.com");
      expect(config.intervalSec).toBe(86400); // 24h
      expect(config.currentRelease).toBeNull();
      expect(config.vendorTagOverride).toBeNull();
    });

    it("accepts custom env overrides", () => {
      const config = readReleaseReconciliationConfig({
        MYRMIDON_CURRENT_RELEASE: "1.6.5",
        MYRMIDON_VENDOR_GITHUB_REPO: "test-org/test-repo",
        MYRMIDON_GITHUB_API_BASE: "https://github.internal.net/api/v3/",
        MYRMIDON_VENDOR_TAG: "v1.7.0",
        MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC: "3600",
        MYRMIDON_RELEASE_TASK_COMPANY_ID: "company-123",
      });

      expect(config.currentRelease).toBe("1.6.5");
      expect(config.vendorRepo).toBe("test-org/test-repo");
      expect(config.gitHubApiBase).toBe("https://github.internal.net/api/v3");
      expect(config.vendorTagOverride).toBe("v1.7.0");
      expect(config.intervalSec).toBe(3600);
      expect(config.companyId).toBe("company-123");
    });
  });

  describe("reconcileReleases", () => {
    it("creates a draft task when vendor tag diverges from current release", async () => {
      const mockClient: GitHubClient = {
        getLatestRelease: async () => ({
          tagName: "v1.7.0",
          name: "Release 1.7.0",
          body: "Fix critical issues and add features.\n- item 1\n- item 2",
        }),
        getLatestTag: async () => ({ name: "v1.7.0" }),
      };

      const sink = new InMemoryIssueSink();

      const result = await reconcileReleases({
        env: {
          MYRMIDON_CURRENT_RELEASE: "1.6.5",
          MYRMIDON_VENDOR_GITHUB_REPO: "paperclipai/paperclip",
        },
        gitHubClient: mockClient,
        issueSink: sink,
        now: () => new Date("2026-11-07T12:00:00Z"),
      });

      expect(result.diverged).toBe(true);
      expect(result.draftTaskCreated).toBe(true);
      expect(result.currentRelease).toBe("1.6.5");
      expect(result.vendorTag).toBe("v1.7.0");
      expect(result.taskId).toBeDefined();

      expect(sink.createdTasks).toHaveLength(1);
      const created = sink.createdTasks[0];
      expect(created.title).toContain("paperclipai/paperclip");
      expect(created.title).toContain("v1.7.0");
      expect(created.title).toContain("1.6.5");
      expect(created.status).toBe("backlog");
      expect(created.priority).toBe("medium");
      expect(created.description).toContain("## Сверка релизов вендора: обнаружено расхождение");
      expect(created.description).toContain("Fix critical issues and add features.");
      expect(created.metadata).toEqual({
        source: "stack-updates-b",
        currentRelease: "1.6.5",
        vendorTag: "v1.7.0",
        vendorRepo: "paperclipai/paperclip",
      });
    });

    it("does NOT create a draft task when vendor tag matches current release", async () => {
      const mockClient: GitHubClient = {
        getLatestRelease: async () => ({
          tagName: "v1.6.5",
          name: "Release 1.6.5",
          body: "Current release notes",
        }),
        getLatestTag: async () => ({ name: "v1.6.5" }),
      };

      const sink = new InMemoryIssueSink();

      const result = await reconcileReleases({
        env: {
          MYRMIDON_CURRENT_RELEASE: "v1.6.5",
          MYRMIDON_VENDOR_GITHUB_REPO: "paperclipai/paperclip",
        },
        gitHubClient: mockClient,
        issueSink: sink,
      });

      expect(result.diverged).toBe(false);
      expect(result.draftTaskCreated).toBe(false);
      expect(result.currentRelease).toBe("v1.6.5");
      expect(result.vendorTag).toBe("v1.6.5");
      expect(sink.createdTasks).toHaveLength(0);
    });

    it("handles matching versions with different formatting (v prefix)", async () => {
      const mockClient: GitHubClient = {
        getLatestRelease: async () => ({
          tagName: "1.6.5",
        }),
        getLatestTag: async () => ({ name: "1.6.5" }),
      };

      const sink = new InMemoryIssueSink();

      const result = await reconcileReleases({
        env: {
          MYRMIDON_CURRENT_RELEASE: "v1.6.5",
        },
        gitHubClient: mockClient,
        issueSink: sink,
      });

      expect(result.diverged).toBe(false);
      expect(result.draftTaskCreated).toBe(false);
      expect(sink.createdTasks).toHaveLength(0);
    });

    it("falls back to git tags if release endpoint returns null", async () => {
      const mockClient: GitHubClient = {
        getLatestRelease: async () => null,
        getLatestTag: async () => ({ name: "v2.0.0" }),
      };

      const sink = new InMemoryIssueSink();

      const result = await reconcileReleases({
        env: {
          MYRMIDON_CURRENT_RELEASE: "1.6.5",
        },
        gitHubClient: mockClient,
        issueSink: sink,
      });

      expect(result.diverged).toBe(true);
      expect(result.draftTaskCreated).toBe(true);
      expect(result.vendorTag).toBe("v2.0.0");
      expect(sink.createdTasks).toHaveLength(1);
    });

    it("respects vendorTagOverride from env without querying GitHub", async () => {
      const mockClient: GitHubClient = {
        getLatestRelease: vi.fn(),
        getLatestTag: vi.fn(),
      };

      const sink = new InMemoryIssueSink();

      const result = await reconcileReleases({
        env: {
          MYRMIDON_CURRENT_RELEASE: "1.6.5",
          MYRMIDON_VENDOR_TAG: "1.8.0",
        },
        gitHubClient: mockClient,
        issueSink: sink,
      });

      expect(result.diverged).toBe(true);
      expect(result.draftTaskCreated).toBe(true);
      expect(result.vendorTag).toBe("1.8.0");
      expect(mockClient.getLatestRelease).not.toHaveBeenCalled();
      expect(mockClient.getLatestTag).not.toHaveBeenCalled();
      expect(sink.createdTasks).toHaveLength(1);
    });
  });

  describe("buildDraftTaskSummary", () => {
    it("formats summary with notes", () => {
      const summary = buildDraftTaskSummary({
        vendorRepo: "paperclipai/paperclip",
        currentRelease: "1.6.5",
        vendorTag: "1.7.0",
        releaseNotes: "Security update\nNew dashboard",
        detectedAt: new Date("2026-11-07T08:00:00Z"),
      });

      expect(summary).toContain("paperclipai/paperclip");
      expect(summary).toContain("1.6.5");
      expect(summary).toContain("1.7.0");
      expect(summary).toContain("Security update");
      expect(summary).toContain("New dashboard");
      expect(summary).toContain("2026-11-07T08:00:00.000Z");
    });
  });

  describe("ReleaseReconciliationService", () => {
    it("starts and stops periodic sweep", async () => {
      let intervalCb: (() => void) | null = null;
      let intervalMs: number | null = null;
      let cleared = false;

      const mockTimers = {
        setInterval: (fn: () => void, ms: number) => {
          intervalCb = fn;
          intervalMs = ms;
          return { unref: () => {} } as unknown as NodeJS.Timeout;
        },
        clearInterval: () => {
          cleared = true;
        },
      };

      const mockClient: GitHubClient = {
        getLatestRelease: async () => ({ tagName: "1.6.5" }),
        getLatestTag: async () => ({ name: "1.6.5" }),
      };

      const sink = new InMemoryIssueSink();

      const service = new ReleaseReconciliationService({
        env: {
          MYRMIDON_CURRENT_RELEASE: "1.6.5",
          MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC: "86400",
        },
        gitHubClient: mockClient,
        issueSink: sink,
        timers: mockTimers,
      });

      expect(service.isRunning()).toBe(false);
      service.start();
      expect(service.isRunning()).toBe(true);
      expect(intervalMs).toBe(86400 * 1000);

      service.stop();
      expect(service.isRunning()).toBe(false);
      expect(cleared).toBe(true);
    });
  });
});
