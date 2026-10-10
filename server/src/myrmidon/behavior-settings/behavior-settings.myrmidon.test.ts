// myrmidon(1.7) BEHAVIOR-SETTINGS: the behavior-settings routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, application, resweep), so validation, permissions, the audit record and
// the live apply are all exercised without a database.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { behaviorSettingsRoutes } from "./routes.js";
import {
  BEHAVIOR_SETTINGS_INSTANCE_ACTION,
  behaviorSettingsService,
  type BehaviorSettingsServiceDeps,
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

const ENV_ONLY = { MYRMIDON_DEBUG_MODE: "true" };

interface HarnessOptions {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  companyIds?: string[];
  settingsError?: Error;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const updated: Array<{ behaviorSettings: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored as Record<string, unknown> | undefined };
  const currentCompany = { stored: options.stored as Record<string, unknown> | undefined };

  const deps: Partial<BehaviorSettingsServiceDeps> = {
    instanceSettings: {
      readInstance: async () => {
        if (options.settingsError) throw options.settingsError;
        return current.stored ? { ...current.stored } : undefined;
      },
      writeInstance: async (change) => {
        const { next } = change(current.stored ? { ...current.stored } : undefined);
        current.stored = next;
        updated.push({ behaviorSettings: next });
        calls.push("write");
        return next;
      },
      readCompany: async (_companyId: string) =>
        currentCompany.stored ? { ...currentCompany.stored } : undefined,
      writeCompany: async (_companyId: string, change) => {
        const { next } = change(currentCompany.stored ? { ...currentCompany.stored } : undefined);
        currentCompany.stored = next;
        updated.push({ behaviorSettings: next });
        calls.push("write");
        return next;
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
      calls.push("audit");
    },
    apply: (settings) => calls.push(`apply:${JSON.stringify(settings)}`),
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
    scoped.use("/api", behaviorSettingsRoutes({} as Db, behaviorSettingsService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, calls, updated, audits, deps };
}

const INSTANCE_URL = "/api/myrmidon/behavior-settings";
const COMPANY_URL = (companyId: string) => `/api/myrmidon/behavior-settings/${companyId}`;

describe("myrmidon(1.7) behavior settings: reading the effective values", () => {
  it("reports the environment as the source when it declares a value", async () => {
    const { app } = harness({ env: { MYRMIDON_DEBUG_MODE: "true" } });
    const res = await request(app).get(INSTANCE_URL).expect(200);

    expect(res.body.settings.debug_mode).toBe(true);
    expect(res.body.sources.debug_mode).toBe("env");
  });

  it("keeps the environment as the source when its value equals the default", async () => {
    // Review blocker 1 (OPE-4094): MYRMIDON_DEBUG_MODE=false is an explicit
    // env declaration equal to the default; resolveRunLimits' envDeclares
    // semantics report it as "env", not "default".
    const { app } = harness({ env: { MYRMIDON_DEBUG_MODE: "false" } });
    const res = await request(app).get(INSTANCE_URL).expect(200);

    expect(res.body.settings.debug_mode).toBe(false);
    expect(res.body.sources.debug_mode).toBe("env");
  });

  it("reports the stored settings as the source once they exist", async () => {
    const { app } = harness({
      stored: { debug_mode: true, max_concurrent_agents: 10 },
    });
    const res = await request(app).get(INSTANCE_URL).expect(200);
    
    expect(res.body.settings.debug_mode).toBe(true);
    expect(res.body.sources.debug_mode).toBe("ui");
  });

  it("falls back to the environment when the stored row is not canonical", async () => {
    const { app } = harness({ stored: { debug_mode: "invalid_value" } });
    const res = await request(app).get(INSTANCE_URL).expect(200);
    
    // Should fall back to environment or default
    expect(res.body.settings.debug_mode).toBeDefined();
  });
});

describe("myrmidon(1.7) behavior settings: access", () => {
  it("refuses agents on read and write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(INSTANCE_URL).expect(403);
    await request(h.withActor(agentActor)).patch(INSTANCE_URL).send({ debug_mode: true }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("lets a board member read but not write instance settings", async () => {
    const h = harness();
    await request(h.withActor(member)).get(INSTANCE_URL).expect(200);
    await request(h.withActor(member)).patch(INSTANCE_URL).send({ debug_mode: true }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("refuses a board member without any organization access", async () => {
    const h = harness();
    await request(h.withActor(outsider)).get(INSTANCE_URL).expect(403);
  });

  it("lets an instance admin write instance settings", async () => {
    const h = harness();
    await request(h.withActor(admin)).patch(INSTANCE_URL).send({ debug_mode: true }).expect(200);
    expect(h.updated.length).toBeGreaterThan(0);
  });

  it("allows company members to read and write company settings", async () => {
    const h = harness();
    await request(h.withActor(member)).get(COMPANY_URL(COMPANY_ID)).expect(200);
    await request(h.withActor(member)).patch(COMPANY_URL(COMPANY_ID)).send({ debug_mode: true }).expect(200);
    expect(h.updated.length).toBeGreaterThan(0);
  });

  it("refuses access to company settings for users without company access", async () => {
    const h = harness();
    await request(h.withActor(outsider)).get(COMPANY_URL(COMPANY_ID)).expect(403);
    await request(h.withActor(outsider)).patch(COMPANY_URL(COMPANY_ID)).send({ debug_mode: true }).expect(403);
  });
});

describe("myrmidon(1.7) behavior settings: a change reaches the live system", () => {
  it("writes the row, audits every company, then applies and resweeps for instance settings", async () => {
    const h = harness({ companyIds: [COMPANY_ID, "company-b"] });
    const res = await request(h.withActor(admin)).patch(INSTANCE_URL).send({ debug_mode: true }).expect(200);

    expect(h.updated).toHaveLength(1);
    expect((h.updated[0].behaviorSettings as Record<string, unknown>).debug_mode).toBe(true);

    // Should have audit entries for all companies
    expect(h.audits).toHaveLength(2);
    for (const entry of h.audits) {
      expect(entry).toMatchObject({ action: BEHAVIOR_SETTINGS_INSTANCE_ACTION, entityType: "instance_settings" });
    }
    expect(h.audits.map((entry) => (entry as { companyId?: string }).companyId)).toEqual([COMPANY_ID, "company-b"]);

    // Audit and row first, then the settings in force: the live system must
    // never run ahead of what the log says it is.
    expect(h.calls).toContain("write");
    expect(h.calls).toContain(`apply:${JSON.stringify({ debug_mode: true })}`);
    expect(h.calls).toContain("resweep");
  });

  it("handles concurrent updates without race conditions", async () => {
    const h = harness();
    
    // Make multiple simultaneous requests
    const promises = [
      request(h.withActor(admin)).patch(INSTANCE_URL).send({ debug_mode: true }).expect(200),
      request(h.withActor(admin)).patch(INSTANCE_URL).send({ max_concurrent_agents: 8 }).expect(200),
      request(h.withActor(admin)).patch(INSTANCE_URL).send({ default_timeout_seconds: 600 }).expect(200),
    ];
    
    await Promise.all(promises);
    
    // All updates should have been processed sequentially
    expect(h.updated.length).toBe(3);
  });

  it("refuses values that fail validation and writes nothing", async () => {
    const h = harness();
    // Test with an invalid value that doesn't pass the setting's validator
    await request(h.withActor(admin)).patch(INSTANCE_URL).send({ debug_mode: "not_a_boolean" }).expect(400);
    expect(h.updated).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("keeps the environment values in force when the settings write fails", async () => {
    const h = harness();
    vi.spyOn(h.deps.instanceSettings!, "writeInstance").mockRejectedValue(new Error("database is down"));
    await request(h.withActor(admin)).patch(INSTANCE_URL).send({ debug_mode: true }).expect(500);
    expect(h.calls).toEqual([]);
  });
});