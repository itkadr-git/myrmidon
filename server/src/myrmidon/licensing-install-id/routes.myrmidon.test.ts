import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { errorHandler } from "../../middleware/index.js";
import { licensingInstallIdRoutes } from "./routes.js";

const MACHINE_ID = "0123456789abcdef0123456789abcdef";

function app(isInstanceAdmin: boolean) {
  const server = express();
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      source: "session",
      userId: "user-1",
      isInstanceAdmin,
      companyIds: [],
    };
    next();
  });
  server.use("/api", licensingInstallIdRoutes());
  server.use(errorHandler);
  return server;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/licensing/install-id", () => {
  it("returns the override for an instance admin", async () => {
    vi.stubEnv("MYR_LICENSE_INSTANCE_ID", "myr-override");
    const response = await request(app(true)).get("/api/licensing/install-id").expect(200);
    expect(response.body).toEqual({ install_id: "myr-override", source: "MYR_LICENSE_INSTANCE_ID" });
  });

  it("derives the A1 ID from the primary machine-id file", async () => {
    vi.stubEnv("MYR_LICENSE_INSTANCE_ID", "");
    const expected = `myr-${createHash("sha256").update(MACHINE_ID, "utf8").digest("hex").slice(0, 20)}`;
    const server = express();
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board", source: "session", userId: "user-1", isInstanceAdmin: true, companyIds: [],
      };
      next();
    });
    server.use("/api", licensingInstallIdRoutes(() => MACHINE_ID));
    server.use(errorHandler);
    const response = await request(server).get("/api/licensing/install-id").expect(200);
    expect(response.body).toEqual({ install_id: expected, source: "machine-id" });
  });

  it("rejects non-admin board users", async () => {
    vi.stubEnv("MYR_LICENSE_INSTANCE_ID", "myr-override");
    await request(app(false)).get("/api/licensing/install-id").expect(403);
  });
});
