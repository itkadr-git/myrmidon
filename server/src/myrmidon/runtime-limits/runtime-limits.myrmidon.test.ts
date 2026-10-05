// myrmidon(C0) RUNTIME-LIMITS: the runtime-limits routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, admission, resweep), so validation, permissions, the audit record and
// the live apply are all exercised without a database.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { runtimeLimitsRoutes } from "./routes.js";
import {
  RUNTIME_LIMITS_ACTION,
  runtimeLimitsService,
  type RuntimeLimitsServiceDeps,
} from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const outsider = { ...member, userId: "user-c", companyIds: [] };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

const ENV_ONLY = { MYRMIDON_MAX_CONCURRENT_RUNS: "8" };
// myrmidon(1.6.2 RUN-ADMISSION): the start ramp and the host floor are on by default.
const RAMP_AND_HOST = { maxStartsPerMinute: 5, minFreeHostMemoryMb: 15360, maxHostLoadPercentPerCore: 90 };

interface HarnessOptions {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  companyIds?: string[];
  settingsError?: Error;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const updated: Array<{ runLimits: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored as unknown };

  const deps: Partial<RuntimeLimitsServiceDeps> = {
    settings: {
      getGeneral: async () => {
        if (options.settingsError) throw options.settingsError;
        return { runLimits: current.stored };
      },
      updateGeneral: async (patch: { runLimits: unknown }) => {
        current.stored = patch.runLimits;
        updated.push(patch);
        calls.push("write");
        return {};
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
      calls.push("audit");
    },
    apply: (limits) => calls.push(`apply:${limits.maxConcurrentRuns}`),
    scheduleResweep: () => calls.push("resweep"),
    env: options.env ?? ENV_ONLY,
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", runtimeLimitsRoutes({} as Db, runtimeLimitsService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, calls, updated, audits, deps };
}

const URL = "/api/myrmidon/runtime-limits";

describe("myrmidon(C0) runtime limits: reading the effective values", () => {
  it("reports the environment values as the source when settings never saved them", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body).toEqual({
      limits: { maxConcurrentRuns: 8, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST },
      sources: {
        maxConcurrentRuns: "env",
        maxStartsPerMinute: "default",
        minFreeMemoryMb: "default",
        runMemoryEstimateMb: "default",
        minFreeHostMemoryMb: "default",
        maxHostLoadPercentPerCore: "default",
      },
    });
  });

  it("reports the stored settings as the source once they exist", async () => {
    const { app } = harness({
      stored: {
        maxConcurrentRuns: 3,
        maxStartsPerMinute: 4,
        minFreeMemoryMb: 1500,
        runMemoryEstimateMb: 250,
        minFreeHostMemoryMb: 8192,
      },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.limits).toEqual({
      maxConcurrentRuns: 3,
      maxStartsPerMinute: 4,
      minFreeMemoryMb: 1500,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 8192,
      // myrmidon(1.6.5): the row lacks the CPU ceiling; it resolves from the default.
      maxHostLoadPercentPerCore: 90,
    });
    expect(Object.values(res.body.sources)).toEqual([
      "settings",
      "settings",
      "settings",
      "settings",
      "settings",
      "default",
    ]);
  });

  it("myrmidon(1.6.2): a row saved before the host floor existed keeps its values and gets the default floor", async () => {
    const { app } = harness({
      stored: { maxConcurrentRuns: 3, maxStartsPerMinute: 12, minFreeMemoryMb: 1500, runMemoryEstimateMb: 250 },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.limits).toEqual({
      maxConcurrentRuns: 3,
      maxStartsPerMinute: 12,
      minFreeMemoryMb: 1500,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 15360,
      maxHostLoadPercentPerCore: 90,
    });
    expect(res.body.sources.maxStartsPerMinute).toBe("settings");
    expect(res.body.sources.minFreeHostMemoryMb).toBe("default");
    expect(res.body.sources.maxHostLoadPercentPerCore).toBe("default");
  });

  it("falls back to the environment when the stored row is not canonical", async () => {
    const { app } = harness({ stored: { maxConcurrentRuns: 0 } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.limits.maxConcurrentRuns).toBe(8);
    expect(res.body.sources.maxConcurrentRuns).toBe("env");
  });
});

describe("myrmidon(C0) runtime limits: access", () => {
  it("refuses agents on read and write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(agentActor)).patch(URL).send({ maxConcurrentRuns: 4 }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("lets a board member read but not write", async () => {
    const h = harness();
    await request(h.withActor(member)).get(URL).expect(200);
    await request(h.withActor(member)).patch(URL).send({ maxConcurrentRuns: 4 }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("refuses a board member without any organization access", async () => {
    const h = harness();
    await request(h.withActor(outsider)).get(URL).expect(403);
  });

  it("lets an instance admin write", async () => {
    const h = harness();
    await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: 4 }).expect(200);
    expect(h.updated).toEqual([
      { runLimits: { maxConcurrentRuns: 4, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST } },
    ]);
  });
});

describe("myrmidon(C0) runtime limits: a change reaches the live admission", () => {
  it("writes the row, audits every company, then applies and resweeps", async () => {
    const h = harness({ companyIds: [COMPANY_ID, "company-b"] });
    const res = await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: 12 }).expect(200);

    // The environment value became the stored value for the keys the patch leaves alone.
    expect(h.updated).toEqual([
      { runLimits: { maxConcurrentRuns: 12, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST } },
    ]);
    expect(res.body.limits.maxConcurrentRuns).toBe(12);
    expect(res.body.sources.maxConcurrentRuns).toBe("settings");

    expect(h.audits).toHaveLength(2);
    for (const entry of h.audits) {
      expect(entry).toMatchObject({ action: RUNTIME_LIMITS_ACTION, entityType: "instance_settings" });
      expect(entry.details).toEqual({
        previous: { maxConcurrentRuns: 8, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST },
        next: { maxConcurrentRuns: 12, minFreeMemoryMb: null, runMemoryEstimateMb: 300, ...RAMP_AND_HOST },
        changedKeys: ["maxConcurrentRuns"],
      });
    }
    expect(h.audits.map((entry) => entry.companyId)).toEqual([COMPANY_ID, "company-b"]);

    // Audit and row first, then the limits in force: the live admission must
    // never run ahead of what the log says it is.
    expect(h.calls).toEqual(["write", "audit", "audit", "apply:12", "resweep"]);
  });

  it("can switch a cap off with null and keeps the per-run budget", async () => {
    const h = harness({ stored: { maxConcurrentRuns: 5, maxStartsPerMinute: 6, minFreeMemoryMb: 7, runMemoryEstimateMb: 250 } });
    const res = await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: null }).expect(200);
    expect(res.body.limits).toEqual({
      maxConcurrentRuns: null,
      maxStartsPerMinute: 6,
      minFreeMemoryMb: 7,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 15360,
      maxHostLoadPercentPerCore: 90,
    });
  });

  it("myrmidon(1.6.2): the host floor and the start ramp change on the fly and can be switched off", async () => {
    const h = harness();
    const res = await request(h.withActor(admin))
      .patch(URL)
      .send({ minFreeHostMemoryMb: 12288, maxStartsPerMinute: 3 })
      .expect(200);
    expect(res.body.limits).toMatchObject({ minFreeHostMemoryMb: 12288, maxStartsPerMinute: 3 });
    expect(res.body.sources.minFreeHostMemoryMb).toBe("settings");
    expect(h.audits[0]!.details).toMatchObject({ changedKeys: ["maxStartsPerMinute", "minFreeHostMemoryMb"] });
    expect(h.calls).toEqual(["write", "audit", "apply:8", "resweep"]);

    const off = await request(h.withActor(admin)).patch(URL).send({ minFreeHostMemoryMb: null }).expect(200);
    expect(off.body.limits.minFreeHostMemoryMb).toBeNull();
    await request(h.withActor(admin)).patch(URL).send({ minFreeHostMemoryMb: 0 }).expect(400);
  });

  it("myrmidon(1.6.5): the host CPU ceiling changes on the fly and can be switched off", async () => {
    const h = harness();
    const res = await request(h.withActor(admin))
      .patch(URL)
      .send({ maxHostLoadPercentPerCore: 150 })
      .expect(200);
    expect(res.body.limits.maxHostLoadPercentPerCore).toBe(150);
    expect(res.body.sources.maxHostLoadPercentPerCore).toBe("settings");
    expect(h.audits[0]!.details).toMatchObject({ changedKeys: ["maxHostLoadPercentPerCore"] });

    const off = await request(h.withActor(admin)).patch(URL).send({ maxHostLoadPercentPerCore: null }).expect(200);
    expect(off.body.limits.maxHostLoadPercentPerCore).toBeNull();
    await request(h.withActor(admin)).patch(URL).send({ maxHostLoadPercentPerCore: 0 }).expect(400);
    await request(h.withActor(admin)).patch(URL).send({ maxHostLoadPercentPerCore: 1.5 }).expect(400);
    // The refused writes changed nothing after the two accepted ones.
    expect(h.updated.at(-1)!.runLimits).toMatchObject({ maxHostLoadPercentPerCore: null });
  });

  it("refuses values that are not a positive integer and writes nothing", async () => {
    const h = harness();
    for (const body of [
      { maxConcurrentRuns: 0 },
      { maxConcurrentRuns: -3 },
      { maxConcurrentRuns: 1.5 },
      { maxConcurrentRuns: "8" },
      { runMemoryEstimateMb: null },
      { minFreeMemoryMb: 100, bogus: 1 },
    ]) {
      await request(h.withActor(admin)).patch(URL).send(body).expect(400);
    }
    expect(h.updated).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("keeps the environment values in force when the settings write fails", async () => {
    const h = harness();
    vi.spyOn(h.deps.settings!, "updateGeneral").mockRejectedValue(new Error("database is down"));
    await request(h.withActor(admin)).patch(URL).send({ maxConcurrentRuns: 12 }).expect(500);
    expect(h.calls).toEqual([]);
  });
});