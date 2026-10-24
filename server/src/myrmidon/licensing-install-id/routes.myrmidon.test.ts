import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import type { InstallId } from "../licensing/install-id.js";
import { licensingInstallIdRoutes } from "./routes.js";

function app(isInstanceAdmin: boolean, id: InstallId) {
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
  server.use("/api", licensingInstallIdRoutes(async () => id));
  server.use(errorHandler);
  return server;
}

describe("GET /api/licensing/install-id", () => {
  it("returns the stored id for an instance admin", async () => {
    const response = await request(app(true, { installId: "myr-3eb1bd439947eb762998", source: "machine-id" }))
      .get("/api/licensing/install-id")
      .expect(200);
    expect(response.body).toEqual({ install_id: "myr-3eb1bd439947eb762998", source: "machine-id" });
  });

  it("keeps the legacy source name for an id taken from the environment", async () => {
    const response = await request(app(true, { installId: "myr-override", source: "env" }))
      .get("/api/licensing/install-id")
      .expect(200);
    expect(response.body).toEqual({ install_id: "myr-override", source: "MYR_LICENSE_INSTANCE_ID" });
  });

  it("rejects non-admin board users", async () => {
    await request(app(false, { installId: "myr-x", source: "machine-id" })).get("/api/licensing/install-id").expect(403);
  });
});
