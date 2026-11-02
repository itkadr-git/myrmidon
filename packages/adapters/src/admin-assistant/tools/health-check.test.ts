import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CLUSTER_HEALTH_CHECK_TOOL_NAME,
  clusterHealthCheckTool,
  clusterHealthCheckToolDefinition,
  clusterHealthCheckToolSchema,
  executeClusterHealthCheck,
  measureDiskSpaceSafe,
  type ClusterHealthCheckResult,
  type ClusterHealthMetricsProvider,
} from "./health-check.js";

describe("cluster_health_check tool", () => {
  describe("LiteLLM function calling schema", () => {
    it("exports the expected tool name", () => {
      expect(CLUSTER_HEALTH_CHECK_TOOL_NAME).toBe("cluster_health_check");
      expect(clusterHealthCheckTool.name).toBe("cluster_health_check");
    });

    it("matches OpenAI / LiteLLM function calling tool specification", () => {
      expect(clusterHealthCheckToolDefinition.type).toBe("function");
      expect(clusterHealthCheckToolDefinition.function.name).toBe("cluster_health_check");
      expect(clusterHealthCheckToolDefinition.function.description).toContain(
        "Diagnostics tool for the admin assistant model",
      );
      expect(clusterHealthCheckToolDefinition.function.parameters.type).toBe("object");
      expect(clusterHealthCheckToolDefinition.function.parameters.properties).toHaveProperty("path");
      expect(clusterHealthCheckToolDefinition.function.parameters.properties).toHaveProperty("companyId");
    });

    it("provides clusterHealthCheckToolSchema alias", () => {
      expect(clusterHealthCheckToolSchema).toBe(clusterHealthCheckToolDefinition);
    });
  });

  describe("Safe execution without direct shell command invocation", () => {
    it("does not call any child_process shell functions during execution", async () => {
      const execSpy = vi.spyOn(childProcess, "exec");
      const execSyncSpy = vi.spyOn(childProcess, "execSync");
      const spawnSpy = vi.spyOn(childProcess, "spawn");
      const spawnSyncSpy = vi.spyOn(childProcess, "spawnSync");

      const result = await executeClusterHealthCheck();

      expect(execSpy).not.toHaveBeenCalled();
      expect(execSyncSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();

      execSpy.mockRestore();
      execSyncSpy.mockRestore();
      spawnSpy.mockRestore();
      spawnSyncSpy.mockRestore();

      expect(result).toBeDefined();
      expect(result.status).toMatch(/^(healthy|warning|critical)$/);
    });

    it("safely measures disk space using statfs syscall", async () => {
      const disk = await measureDiskSpaceSafe();

      expect(disk).toHaveProperty("path");
      expect(typeof disk.totalBytes).toBe("number");
      expect(typeof disk.freeBytes).toBe("number");
      expect(typeof disk.usedBytes).toBe("number");
      expect(typeof disk.usedPercent).toBe("number");
      expect(disk.status).toMatch(/^(healthy|warning|critical)$/);
      expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes);
      expect(disk.usedPercent).toBeGreaterThanOrEqual(0);
      expect(disk.usedPercent).toBeLessThanOrEqual(100);
    });

    it("handles filesystem measurement errors gracefully without throwing", async () => {
      const statfsSpy = vi.spyOn(fs, "statfs").mockRejectedValueOnce(new Error("Permission denied"));

      const disk = await measureDiskSpaceSafe("/restricted/path");

      expect(disk.path).toBe("/restricted/path");
      expect(disk.totalBytes).toBe(0);
      expect(disk.freeBytes).toBe(0);
      expect(disk.status).toBe("warning");

      statfsSpy.mockRestore();
    });
  });

  describe("Compact JSON health report", () => {
    it("returns a compact JSON with all key health parameters", async () => {
      const mockProvider: ClusterHealthMetricsProvider = {
        getAgents: () => ({
          total: 5,
          active: 2,
          idle: 3,
          paused: 0,
          error: 0,
        }),
        getTasks: () => ({
          queued: 4,
          inProgress: 2,
          blocked: 0,
          totalOpen: 6,
        }),
        getHeartbeats: () => ({
          activeRuns: 1,
          maxDelayMs: 4200,
          staleCount: 0,
          status: "healthy",
        }),
        getDisk: () => ({
          path: "/workspace",
          totalBytes: 100_000_000,
          freeBytes: 60_000_000,
          usedBytes: 40_000_000,
          usedPercent: 40,
          status: "healthy",
        }),
      };

      const result: ClusterHealthCheckResult = await executeClusterHealthCheck(
        { companyId: "comp-1" },
        { metricsProvider: mockProvider },
      );

      expect(result).toEqual({
        status: "healthy",
        timestamp: expect.any(String),
        agents: {
          total: 5,
          active: 2,
          idle: 3,
          paused: 0,
          error: 0,
        },
        tasks: {
          queued: 4,
          inProgress: 2,
          blocked: 0,
          totalOpen: 6,
        },
        heartbeats: {
          activeRuns: 1,
          maxDelayMs: 4200,
          staleCount: 0,
          status: "healthy",
        },
        disk: {
          path: "/workspace",
          totalBytes: 100_000_000,
          freeBytes: 60_000_000,
          usedBytes: 40_000_000,
          usedPercent: 40,
          status: "healthy",
        },
      });
    });

    it("elevates status to warning when disk or tasks indicate warnings", async () => {
      const mockProvider: ClusterHealthMetricsProvider = {
        getAgents: () => ({ total: 2, active: 1, idle: 1, paused: 0, error: 0 }),
        getTasks: () => ({ queued: 1, inProgress: 1, blocked: 2, totalOpen: 4 }), // blocked > 0
        getHeartbeats: () => ({ activeRuns: 0, maxDelayMs: 1000, staleCount: 0, status: "healthy" }),
        getDisk: () => ({
          path: "/data",
          totalBytes: 100_000,
          freeBytes: 15_000,
          usedBytes: 85_000,
          usedPercent: 85, // >= 80% warning
          status: "warning",
        }),
      };

      const result = await executeClusterHealthCheck({}, { metricsProvider: mockProvider });
      expect(result.status).toBe("warning");
    });

    it("elevates status to critical when agent error or critical disk/heartbeat occurs", async () => {
      const mockProvider: ClusterHealthMetricsProvider = {
        getAgents: () => ({ total: 2, active: 0, idle: 1, paused: 0, error: 1 }), // error > 0
        getTasks: () => ({ queued: 0, inProgress: 0, blocked: 0, totalOpen: 0 }),
        getHeartbeats: () => ({ activeRuns: 0, maxDelayMs: 120_000, staleCount: 2, status: "critical" }),
        getDisk: () => ({
          path: "/data",
          totalBytes: 100_000,
          freeBytes: 5_000,
          usedBytes: 95_000,
          usedPercent: 95,
          status: "critical",
        }),
      };

      const result = await executeClusterHealthCheck({}, { metricsProvider: mockProvider });
      expect(result.status).toBe("critical");
    });

    it("supports querying server API via fetcher if apiBaseUrl is specified", async () => {
      const mockResponse: ClusterHealthCheckResult = {
        status: "healthy",
        timestamp: "2026-10-31T12:00:00.000Z",
        agents: { total: 1, active: 1, idle: 0, paused: 0, error: 0 },
        tasks: { queued: 0, inProgress: 1, blocked: 0, totalOpen: 1 },
        heartbeats: { activeRuns: 1, maxDelayMs: 500, staleCount: 0, status: "healthy" },
        disk: {
          path: "/data",
          totalBytes: 1000,
          freeBytes: 800,
          usedBytes: 200,
          usedPercent: 20,
          status: "healthy",
        },
      };

      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await executeClusterHealthCheck(
        { path: "/data", companyId: "c1" },
        {
          apiBaseUrl: "http://127.0.0.1:3100",
          authToken: "test-token",
          fetcher: fetcher as any,
        },
      );

      expect(fetcher).toHaveBeenCalledWith(
        "http://127.0.0.1:3100/admin-assistant/cluster-health?path=%2Fdata&companyId=c1",
        {
          headers: {
            Accept: "application/json",
            Authorization: "Bearer test-token",
          },
        },
      );
      expect(result).toEqual(mockResponse);
    });
  });
});
