import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStandbyStatus, haRoutes } from "../routes/ha.js";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("standby readiness status", () => {
  it("returns explicit not_configured without a second site", async () => {
    delete process.env.MYRMIDON_HA_GEO_STANDBY_URL;
    delete process.env.PAPERCLIP_HA_GEO_STANDBY_URL;
    await expect(getStandbyStatus()).resolves.toMatchObject({
      status: "not_configured",
      checks: [],
    });
  });

  it("returns per-check status and timestamps when configured", async () => {
    process.env.MYRMIDON_HA_GEO_STANDBY_URL = "https://standby.example.test/";
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await getStandbyStatus({ fetchImpl });
    expect(result.status).toBe("ready");
    expect(result.checks).toEqual([
      expect.objectContaining({ name: "health", status: "ready", checkedAt: expect.any(String) }),
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://standby.example.test/api/health",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(JSON.stringify(result)).not.toContain("standby.example.test");
  });

  it("records a failed check without throwing", async () => {
    process.env.MYRMIDON_HA_GEO_STANDBY_URL = "https://standby.example.test";
    const result = await getStandbyStatus({ fetchImpl: vi.fn().mockRejectedValue(new Error("network secret")) });
    expect(result.status).toBe("unhealthy");
    expect(result.checks[0]).toMatchObject({ name: "health", status: "unhealthy" });
    expect(JSON.stringify(result)).not.toContain("network secret");
  });
});

describe("GET /api/ha/standby", () => {
  it("returns the safe status payload and 200 for not_configured", async () => {
    delete process.env.MYRMIDON_HA_GEO_STANDBY_URL;
    delete process.env.PAPERCLIP_HA_GEO_STANDBY_URL;
    const app = express();
    app.use("/api/ha", haRoutes());
    const res = await request(app).get("/api/ha/standby");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "not_configured", checks: [] });
    expect(res.body).not.toHaveProperty("url");
  });
});
