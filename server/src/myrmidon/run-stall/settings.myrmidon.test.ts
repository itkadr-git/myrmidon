// myrmidon(RUN-STALL-SETTINGS, 1.6.5): the run-stall settings routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, the live sweep apply), so validation, permissions, the audit record,
// the read-write-audit-apply order and the no-restart apply are all exercised
// without a database. The "applies to the live sweep without a restart" case
// drives the REAL sweep (`createRunStallSweep`) as the apply target: the new
// values must be what the very next pass works with, which is the contract
// the settings page sells.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { resolveTeamLivenessSettings } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { runStallRoutes } from "./routes.js";
import {
  RUN_STALL_ACTION,
  runStallService,
  type RunStallServiceDeps,
} from "./settings-service.js";
import { createRunStallSweep } from "./sweep.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

const ENV_ONLY = { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "900" };
const DEFAULTS = { enabled: true, thresholdSec: 1200, checkIntervalSec: 60, pageSize: 50 };

interface HarnessOptions {
  stored?: unknown;
  /** `general.teamLiveness`: the owner of `enabled` and the threshold. */
  livenessStored?: unknown;
  env?: Record<string, string | undefined>;
  companyIds?: string[];
  settingsError?: Error;
  apply?: (settings: unknown) => void;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const updated: Array<{ runStall: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored as unknown };

  const deps: Partial<RunStallServiceDeps> = {
    settings: {
      getGeneral: async () => {
        if (options.settingsError) throw options.settingsError;
        return { runStall: current.stored };
      },
      updateGeneral: async (patch: { runStall: unknown }) => {
        current.stored = patch.runStall;
        updated.push({ runStall: patch.runStall });
        calls.push("write");
        return {};
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
      calls.push("audit");
    },
    apply:
      options.apply ??
      ((settings) => calls.push(`apply:${(settings as { thresholdSec: number }).thresholdSec}`)),
    readLiveness: async () =>
      resolveTeamLivenessSettings({ stored: options.livenessStored, env: options.env ?? ENV_ONLY }),
    env: options.env ?? ENV_ONLY,
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", runStallRoutes({} as Db, runStallService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, calls, updated, audits, deps };
}

const URL = "/api/myrmidon/run-stall";

describe("myrmidon(RUN-STALL-SETTINGS): reading the effective values", () => {
  it("reports the environment and the defaults when settings were never saved", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body).toEqual({
      settings: { ...DEFAULTS, thresholdSec: 900 },
      sources: { enabled: "default", thresholdSec: "env", checkIntervalSec: "default", pageSize: "default" },
      managedBy: { keys: ["enabled", "thresholdSec"], owner: "team-liveness", path: "/api/myrmidon/team-liveness" },
    });
  });

  it("keeps the fix on for an unrecognized environment value and marks the source a default", async () => {
    const { app } = harness({ env: { MYRMIDON_RUN_STALL_ENABLED: "proably" } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.settings.enabled).toBe(true);
    expect(res.body.sources.enabled).toBe("default");
  });

  it("reads an explicit environment off and a switched-off stored value", async () => {
    const envOff = await request(harness({ env: { MYRMIDON_RUN_STALL_ENABLED: "off" } }).app).get(URL).expect(200);
    expect(envOff.body.settings.enabled).toBe(false);
    expect(envOff.body.sources.enabled).toBe("env");

    const storedOff = await request(harness({ livenessStored: { runStallEnabled: false } }).app).get(URL).expect(200);
    expect(storedOff.body.settings.enabled).toBe(false);
    expect(storedOff.body.sources.enabled).toBe("settings");
  });

  it("reports the interval and page size from the stored row; enabled and threshold always come from team-liveness", async () => {
    const { app } = harness({
      stored: { enabled: false, thresholdSec: 300, checkIntervalSec: 30, pageSize: 10 },
      livenessStored: { runStallEnabled: true, runStallThresholdSec: 600 },
    });
    const res = await request(app).get(URL).expect(200);
    // The stale copies inside the run-stall row (false / 300) are not what the sweep uses.
    expect(res.body.settings).toEqual({ enabled: true, thresholdSec: 600, checkIntervalSec: 30, pageSize: 10 });
    expect(res.body.sources).toEqual({
      enabled: "settings",
      thresholdSec: "settings",
      checkIntervalSec: "settings",
      pageSize: "settings",
    });
  });

  it("falls back to the environment when the stored row is not canonical", async () => {
    const { app } = harness({ stored: { thresholdSec: 30 } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.settings).toEqual({ ...DEFAULTS, thresholdSec: 900 });
    expect(res.body.sources.thresholdSec).toBe("env");
  });
});

describe("myrmidon(RUN-STALL-SETTINGS): access", () => {
  it("refuses agents on read and write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(agentActor)).patch(URL).send({ checkIntervalSec: 30 }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("lets a board member read but not write", async () => {
    const h = harness();
    await request(h.withActor(member)).get(URL).expect(200);
    await request(h.withActor(member)).patch(URL).send({ checkIntervalSec: 30 }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("lets an instance admin write", async () => {
    const h = harness();
    await request(h.withActor(admin)).patch(URL).send({ checkIntervalSec: 30 }).expect(200);
    expect(h.updated).toEqual([{ runStall: { ...DEFAULTS, thresholdSec: 900, checkIntervalSec: 30 } }]);
  });
});

describe("myrmidon(RUN-STALL-SETTINGS): a change reaches the live sweep", () => {
  it("writes the row, audits every company, then applies", async () => {
    const h = harness({ companyIds: [COMPANY_ID, "company-b"] });
    const res = await request(h.withActor(admin)).patch(URL).send({ checkIntervalSec: 30, pageSize: 10 }).expect(200);

    // The environment value became the stored value for the key the patch leaves alone.
    expect(h.updated).toEqual([{ runStall: { enabled: true, thresholdSec: 900, checkIntervalSec: 30, pageSize: 10 } }]);
    expect(res.body.settings).toEqual({ enabled: true, thresholdSec: 900, checkIntervalSec: 30, pageSize: 10 });
    expect(res.body.sources.checkIntervalSec).toBe("settings");

    expect(h.audits).toHaveLength(2);
    for (const entry of h.audits) {
      expect(entry).toMatchObject({ action: RUN_STALL_ACTION, entityType: "instance_settings" });
      expect(entry.details).toEqual({
        previous: { ...DEFAULTS, thresholdSec: 900 },
        next: { enabled: true, thresholdSec: 900, checkIntervalSec: 30, pageSize: 10 },
        changedKeys: ["checkIntervalSec", "pageSize"],
      });
    }
    expect(h.audits.map((entry) => entry.companyId)).toEqual([COMPANY_ID, "company-b"]);

    // Audit and row first, then the settings in force: the live sweep must
    // never run ahead of what the log says they are.
    expect(h.calls).toEqual(["write", "audit", "audit", "apply:900"]);
  });

  it("applies the saved values to the live sweep without a restart", async () => {
    // The apply target is the real sweep: the next pass must work with the new
    // threshold and interval, and a switch off must idle it — with no restart.
    const sweep = createRunStallSweep({
      db: {} as Db,
      interruptRun: async () => undefined,
      returnIssueToTodo: async () => false,
      wakeAssignee: async () => false,
      isRunUnderMaintenance: async () => false,
      env: { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "900" },
    });
    expect(sweep.settings()).toEqual({
      enabled: true,
      thresholdMs: 900_000,
      checkIntervalMs: 60_000,
      pageSize: 50,
    });

    const h = harness({ env: { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "900" }, apply: (s) => sweep.applySettings(s as never) });
    await request(h.withActor(admin)).patch(URL).send({ checkIntervalSec: 30, pageSize: 20 }).expect(200);

    expect(sweep.settings()).toEqual({
      enabled: true,
      thresholdMs: 900_000,
      checkIntervalMs: 30_000,
      pageSize: 20,
    });

    sweep.resetForTest();
  });

  it("refuses out-of-range values with 400 and writes nothing", async () => {
    const h = harness();
    for (const body of [
      { thresholdSec: 59 },
      { thresholdSec: 24 * 60 * 60 + 1 },
      { thresholdSec: 1.5 },
      { thresholdSec: "300" },
      { checkIntervalSec: 14 },
      { checkIntervalSec: -5 },
      { pageSize: 0 },
      { pageSize: 201 },
      { enabled: "off" },
      { thresholdSec: 300, bogus: 1 },
    ]) {
      await request(h.withActor(admin)).patch(URL).send(body).expect(400);
    }
    expect(h.updated).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("accepts the documented bounds of the two editable keys", async () => {
    const h = harness();
    const res = await request(h.withActor(admin)).patch(URL).send({ checkIntervalSec: 15, pageSize: 200 }).expect(200);
    expect(res.body.settings).toMatchObject({ checkIntervalSec: 15, pageSize: 200 });
    expect(h.audits[0]!.details).toMatchObject({ changedKeys: ["checkIntervalSec", "pageSize"] });
  });

  it("answers 409 with a pointer to team-liveness when enabled or the threshold is patched, and writes nothing", async () => {
    const h = harness();
    for (const body of [
      { enabled: false },
      { thresholdSec: 300 },
      { enabled: true, thresholdSec: 300, pageSize: 10 },
      { enabled: true },
    ]) {
      const res = await request(h.withActor(admin)).patch(URL).send(body).expect(409);
      expect(res.body.error).toMatch(/team-liveness/);
      expect(res.body.details).toMatchObject({
        code: "run_stall_managed_by_team_liveness",
        path: "/api/myrmidon/team-liveness",
      });
    }
    expect(h.updated).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("the sweep keeps obeying team-liveness: a run-stall row with enabled=false does not switch it off", async () => {
    const h = harness({ stored: { ...DEFAULTS, enabled: false }, livenessStored: { runStallEnabled: true } });
    const res = await request(h.app).get(URL).expect(200);
    expect(res.body.settings.enabled).toBe(true);
  });

  it("keeps the environment values in force when the settings write fails", async () => {
    const h = harness();
    vi.spyOn(h.deps.settings!, "updateGeneral").mockRejectedValue(new Error("database is down"));
    await request(h.withActor(admin)).patch(URL).send({ pageSize: 10 }).expect(500);
    expect(h.calls).toEqual([]);
  });
});
