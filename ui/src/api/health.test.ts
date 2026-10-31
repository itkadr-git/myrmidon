import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { healthApi } from "./health";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("healthApi", () => {
  it("initiates tenant-session recovery and keeps the bootstrap request pending", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_invalid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = healthApi.get();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("fetches replication health with query params and returns payload", async () => {
    const mockPayload = {
      status: "ok",
      role: "primary",
      inRecovery: false,
      connectedStandbys: 1,
      standbys: [],
      lag: {
        seconds: 0.12,
        bytes: 1024,
        lastReplayTimestamp: null,
        currentWalLsn: "0/16B2D18",
        lastReceiveLsn: null,
        lastReplayLsn: null,
      },
      warnings: [],
      checkedAt: "2026-10-31T12:00:00.000Z",
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await healthApi.getReplication({
      maxLagSeconds: 30,
      warnLagSeconds: 10,
      role: "primary",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health/replication?maxLagSeconds=30&warnLagSeconds=10&role=primary",
      expect.objectContaining({
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    );
    expect(result).toEqual(mockPayload);
  });

  it("throws formatted error when getReplication receives an error status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_query_parameters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(healthApi.getReplication({ maxLagSeconds: -1 })).rejects.toThrow(
      "invalid_query_parameters",
    );
  });
});
