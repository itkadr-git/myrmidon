// server/src/myrmidon/agent-memory/hindsight-models-routes.myrmidon.test.ts
//
// OPE-9858: Tests for Hindsight model groups Express routes.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { hindsightModelsAdapter } from "./hindsight-models-adapter.js";
import { hindsightModelsRoutes } from "./hindsight-models-routes.js";

function createApp(initialSettings: Record<string, unknown> = {}, isInstanceAdmin = true) {
  let general = { ...initialSettings };
  const adapter = hindsightModelsAdapter({
    getGeneral: async () => ({ ...general }),
    updateGeneral: async (patch) => {
      general = { ...general, ...patch };
    },
  });

  const app = express();
  app.use(express.json());

  // Inject authenticated board actor
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "test-admin-user",
      source: "local_implicit",
      isInstanceAdmin,
    };
    next();
  });

  app.use("/api/myrmidon/hindsight/model-groups", hindsightModelsRoutes(adapter));

  return { app, getGeneral: () => general };
}

describe("hindsight-models-routes", () => {
  it("GET /api/myrmidon/hindsight/model-groups returns 200 with groups and limitations", async () => {
    const { app } = createApp();

    const res = await request(app).get("/api/myrmidon/hindsight/model-groups");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("mock_stored");
    expect(res.body.hotReloadDependency).toBe("OPE-9469");
    expect(res.body.groups).toHaveLength(3);

    const roles = res.body.groups.map((g: any) => g.role);
    expect(roles).toEqual(["write", "summarize", "search"]);

    expect(res.body.limitations.runtimeDependency).toBe("OPE-9469");
    expect(res.body.limitations.items.length).toBeGreaterThanOrEqual(4);
  });

  it("PATCH /api/myrmidon/hindsight/model-groups updates model for a role and returns 200", async () => {
    const { app } = createApp();

    const patchPayload = {
      role: "write",
      model: "claude-3-5-haiku",
    };

    const res = await request(app)
      .patch("/api/myrmidon/hindsight/model-groups")
      .send(patchPayload);

    expect(res.status).toBe(200);
    const writeGroup = res.body.groups.find((g: any) => g.role === "write");
    expect(writeGroup.model).toBe("claude-3-5-haiku");
    expect(writeGroup.source).toBe("setting");
  });

  it("PATCH /api/myrmidon/hindsight/model-groups updates multiple roles", async () => {
    const { app } = createApp();

    const patchPayload = {
      models: {
        write: "gpt-4o",
        summarize: "claude-3-5-haiku",
        search: "bge-m3",
      },
    };

    const res = await request(app)
      .patch("/api/myrmidon/hindsight/model-groups")
      .send(patchPayload);

    expect(res.status).toBe(200);
    const byRole = Object.fromEntries(res.body.groups.map((g: any) => [g.role, g.model]));
    expect(byRole.write).toBe("gpt-4o");
    expect(byRole.summarize).toBe("claude-3-5-haiku");
    expect(byRole.search).toBe("bge-m3");
  });

  it("PATCH /api/myrmidon/hindsight/model-groups rejects empty update with 400", async () => {
    const { app } = createApp();

    const res = await request(app)
      .patch("/api/myrmidon/hindsight/model-groups")
      .send({});

    expect(res.status).toBe(400);
  });
});
