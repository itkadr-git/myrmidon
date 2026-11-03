import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { systemRoutes } from "./system.js";

function extractProjectId(condition: any): string | null {
  if (!condition) return null;
  const projectIds = ["p1", "p2", "p3"];
  if (typeof condition === "string") return projectIds.find((id) => condition.includes(id)) ?? null;
  const visited = new Set();
  function search(obj: any): string | null {
    if (!obj || typeof obj !== "object" || visited.has(obj)) return null;
    visited.add(obj);
    if (typeof obj.value === "string" && projectIds.includes(obj.value)) return obj.value;
    if (typeof obj.right === "string" && projectIds.includes(obj.right)) return obj.right;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === "string" && projectIds.includes(val)) return val;
      if (typeof val === "object" && val !== null) {
        const found = search(val);
        if (found) return found;
      }
    }
    return null;
  }
  return search(condition);
}

function fixture() {
  const projectRows = new Map<string, { companyId: string; env: Record<string, unknown> | null }>([
    ["p1", { companyId: "c1", env: {} }],
    ["p2", { companyId: "c1", env: {} }],
    ["p3", { companyId: "c2", env: {} }],
  ]);
  const db = {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: (condition: any) => { chain.condition = condition; return chain; },
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const id = extractProjectId(chain.condition);
          const row = id ? projectRows.get(id) : undefined;
          return Promise.resolve(row ? [{ id, companyId: row.companyId, env: row.env }] : []).then(resolve, reject);
        },
      };
      return chain;
    },
    update: () => {
      const chain: any = {
        set: (value: any) => { chain.value = value; return chain; },
        where: (condition: any) => {
          const id = extractProjectId(condition);
          if (id && projectRows.has(id)) {
            projectRows.get(id)!.env = chain.value.env;
          }
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve),
      };
      return chain;
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  app.use("/api", systemRoutes(db as any));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 400).json({ error: err.message }));
  return { app, projectRows };
}

describe("project auto-update settings API", () => {
  it("round-trips settings with GET after PUT", async () => {
    const { app } = fixture();
    const settings = { enabled: true, cron: "0 3 * * 1", durationMinutes: 60, timezone: "Europe/Paris" };
    const put = await request(app).put("/api/projects/p1/system/auto-update-settings").send(settings);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.settings).toEqual(settings);
    const get = await request(app).get("/api/projects/p1/system/auto-update-settings");
    expect(get.status).toBe(200);
    expect(get.body.settings).toEqual(settings);
  });

  it("rejects an invalid timezone and malformed/conflicting settings", async () => {
    const { app } = fixture();
    expect((await request(app).put("/api/projects/p1/system/auto-update-settings").send({ enabled: true, cron: "0 3 * * 1", durationMinutes: 60, timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await request(app).put("/api/projects/p1/system/auto-update-settings").send({ enabled: true, cron: "not cron", durationMinutes: 3, timezone: "UTC" })).status).toBe(400);
  });

  it("isolates settings between projects", async () => {
    const { app, projectRows } = fixture();
    const settings = { enabled: true, cron: "0 3 * * 1", durationMinutes: 60, timezone: "UTC" };
    const put = await request(app).put("/api/projects/p1/system/auto-update-settings").send(settings);
    expect(put.status).toBe(200);
    const first = await request(app).get("/api/projects/p1/system/auto-update-settings");
    const second = await request(app).get("/api/projects/p2/system/auto-update-settings");
    const otherCompany = await request(app).get("/api/projects/p3/system/auto-update-settings");
    expect(first.body.settings).toEqual(settings);
    expect(second.body.settings).toEqual({ enabled: false, cron: "0 2 * * 0", durationMinutes: 120, timezone: "UTC" });
    expect(otherCompany.body.settings).toEqual({ enabled: false, cron: "0 2 * * 0", durationMinutes: 120, timezone: "UTC" });
    expect(projectRows.get("p2")!.env).toEqual({});
    expect(projectRows.get("p3")!.env).toEqual({});
  });
});
