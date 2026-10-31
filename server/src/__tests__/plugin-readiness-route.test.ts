import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  createPluginReadinessRouter,
  type PluginReadinessState,
} from "../app.ts";

describe("plugin readiness route (/api/plugins/readiness)", () => {
  function createTestApp(
    pluginReadiness: PluginReadinessState,
    actor?: { userId?: string; type?: string },
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (actor) {
        (req as any).actor = actor;
      }
      next();
    });
    const api = express.Router();
    api.use(createPluginReadinessRouter(pluginReadiness));
    app.use("/api", api);
    return app;
  }

  it("returns 401 when unauthenticated", async () => {
    const state: PluginReadinessState = {
      boardReadyAt: Date.now(),
      plugins: new Map(),
    };
    const app = createTestApp(state);

    const res = await request(app).get("/api/plugins/readiness");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("returns 200 with boardReadyAt and plugins list for authenticated user", async () => {
    const boardReadyAt = 1700000000000;
    const readyAt1 = boardReadyAt + 1250;
    const readyAt2 = boardReadyAt + 3500;

    const state: PluginReadinessState = {
      boardReadyAt,
      plugins: new Map([
        [
          "plugin-1",
          {
            pluginId: "plugin-1",
            pluginKey: "paperclip.slack",
            readyAt: readyAt1,
          },
        ],
        [
          "plugin-2",
          {
            pluginId: "plugin-2",
            pluginKey: "paperclip.github",
            readyAt: readyAt2,
          },
        ],
      ]),
    };
    const app = createTestApp(state, { userId: "user-123", type: "board" });

    const res = await request(app).get("/api/plugins/readiness");
    expect(res.status).toBe(200);
    expect(res.body.boardReadyAt).toBe(new Date(boardReadyAt).toISOString());
    expect(res.body.plugins).toHaveLength(2);
    expect(res.body.plugins[0]).toEqual({
      pluginId: "plugin-1",
      pluginKey: "paperclip.slack",
      readyAt: new Date(readyAt1).toISOString(),
      readyAfterBoardReadyMs: 1250,
    });
    expect(res.body.plugins[1]).toEqual({
      pluginId: "plugin-2",
      pluginKey: "paperclip.github",
      readyAt: new Date(readyAt2).toISOString(),
      readyAfterBoardReadyMs: 3500,
    });
  });

  it("handles null boardReadyAt gracefully", async () => {
    const state: PluginReadinessState = {
      boardReadyAt: null,
      plugins: new Map([
        [
          "plugin-1",
          {
            pluginId: "plugin-1",
            pluginKey: "paperclip.slack",
            readyAt: 1700000001000,
          },
        ],
      ]),
    };
    const app = createTestApp(state, { userId: "user-123" });

    const res = await request(app).get("/api/plugins/readiness");
    expect(res.status).toBe(200);
    expect(res.body.boardReadyAt).toBeNull();
    expect(res.body.plugins[0].readyAfterBoardReadyMs).toBeNull();
  });

  it("supports agent actor authentication", async () => {
    const state: PluginReadinessState = {
      boardReadyAt: Date.now(),
      plugins: new Map(),
    };
    const app = createTestApp(state, { type: "agent" });

    const res = await request(app).get("/api/plugins/readiness");
    expect(res.status).toBe(200);
    expect(res.body.plugins).toEqual([]);
  });

  it("deduplicates multiple registrations for the same plugin ID", async () => {
    const boardReadyAt = 1700000000000;
    const initialReadyAt = boardReadyAt + 1000;
    const updatedReadyAt = boardReadyAt + 2000;

    const state: PluginReadinessState = {
      boardReadyAt,
      plugins: new Map(),
    };
    state.plugins.set("plugin-1", {
      pluginId: "plugin-1",
      pluginKey: "paperclip.slack",
      readyAt: initialReadyAt,
    });
    // Update same plugin (e.g. reload or reactivation)
    state.plugins.set("plugin-1", {
      pluginId: "plugin-1",
      pluginKey: "paperclip.slack",
      readyAt: updatedReadyAt,
    });

    const app = createTestApp(state, { userId: "user-123" });
    const res = await request(app).get("/api/plugins/readiness");
    expect(res.status).toBe(200);
    expect(res.body.plugins).toHaveLength(1);
    expect(res.body.plugins[0].readyAfterBoardReadyMs).toBe(2000);
  });
});
