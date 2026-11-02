// myrmidon(OPE-10218): route coverage for project-scoped auto-update settings.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { systemRoutes } from "./system.js";

function fixture() {
  const projectRows = new Map<string, { companyId: string; env: Record<string, unknown> | null }>([
    ["p1", { companyId: "c1", env: {} }],
    ["p2", { companyId: "c1", env: {} }],
    ["p3", { companyId: "c2", env: {} }],
  ]);
  const db = {
    select: () => {
      let selected: { companyId?: string; env?: Record<string, unknown> | null } | undefined;
      const chain: any = {
        from: () => chain,
        where: (condition: any) => { chain.condition = condition; return chain; },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const values = [...projectRows.entries()].filter(([id]) => String(chain.condition).includes(id));
          selected = values.length ? { companyId: values[0]![1].companyId, env: values[0]![1].env } : undefined;
          return Promise.resolve(selected ? [selected] : []).then(resolve, reject);
        },
      };
      return chain;
    },
    update: () => {
      const chain: any = {
        set: (value: any) => { chain.value = value; return chain; },
        where: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          const target = projectRows.get("p1")!;
          target.env = chain.value.env;
          return Promise.resolve([]).then(resolve);
        },
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
    expect(put.status).toBe(200);
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

  it("isolates the settings response by project", async () => {
    const { app, projectRows } = fixture();
    projectRows.get("p1")!.env = { autoUpdateSettings: { enabled: true, cron: "0 3 * * 1", durationMinutes: 60, timezone: "UTC" } };
    const first = await request(app).get("/api/projects/p1/system/auto-update-settings");
    const second = await request(app).get("/api/projects/p2/system/auto-update-settings");
    expect(first.body.settings.enabled).toBe(true);
    expect(second.body.settings).toEqual({ enabled: false, cron: "0 2 * * 0", durationMinutes: 120, timezone: "UTC" });
  });
});
