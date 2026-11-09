import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatsApi } from "./heartbeats";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("heartbeatsApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("requests summary rows for hot-path history consumers", async () => {
    await heartbeatsApi.list("company-1", undefined, 200, { summary: true });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?limit=200&summary=true");
  });

  it("keeps full row requests as the default for run-history screens", async () => {
    await heartbeatsApi.list("company-1", "agent-1", 25);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?agentId=agent-1&limit=25");
  });

  it("passes a before cursor to the heartbeat runs endpoint", async () => {
    await heartbeatsApi.list("company-1", "agent-1", 200, { before: "2026-11-07T00:00:00.000Z" });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/heartbeat-runs?agentId=agent-1&limit=200&before=2026-11-07T00%3A00%3A00.000Z",
    );
  });

  it("passes wakeReason and hasResult options to filter runs", async () => {
    await heartbeatsApi.list("company-1", "agent-1", 50, {
      wakeReason: "issue_commented",
      hasResult: true,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/heartbeat-runs?agentId=agent-1&limit=50&wakeReason=issue_commented&hasResult=true",
    );
  });
});

describe("heartbeatsApi.listPage", () => {
  it("returns the array body and X-Next-Cursor response header", async () => {
    const runs = [{ id: "run-1" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(runs), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Next-Cursor": "2026-11-07T00:00:00.000Z" },
    })));

    await expect(heartbeatsApi.listPage("company-1", "agent-1")).resolves.toEqual({
      runs,
      nextCursor: "2026-11-07T00:00:00.000Z",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/companies/company-1/heartbeat-runs?agentId=agent-1&limit=200",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("heartbeatsApi.liveRunsForCompany", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("keeps the legacy numeric minCount signature", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", 4);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=4");
  });

  it("passes minCount and limit options to the company live-runs endpoint", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", { minCount: 50, limit: 50 });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=50&limit=50");
  });
});

describe("heartbeatsApi.downloadProviderTrace", () => {
  it("initiates tenant-session recovery for a direct trace download", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const request = heartbeatsApi.downloadProviderTrace("run-1");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});
