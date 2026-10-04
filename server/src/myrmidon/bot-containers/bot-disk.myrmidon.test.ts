// myrmidon(BOT-DISK-A): GET/PATCH /api/myrmidon/bot-disk.
//
// The routes run over the real service with a fake settings row that parses
// every read through the real general-settings validator, so the permission
// rules, the audit record, the persistence of `general.botDisk` and the
// lenient stored shape are all exercised without a database (the embedded
// Postgres round trip lives in bot-disk.db.myrmidon.test.ts).

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  BOT_DISK_DEFAULT_IDLE_TTL_MS,
  BOT_DISK_UPDATED_ACTION,
  instanceGeneralSettingsSchema,
} from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { botDiskRoutes } from "./bot-disk-routes.js";
import {
  botDiskService,
  resolveBotDiskLifecycleConfig,
  type BotDiskServiceDeps,
} from "./bot-disk-service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

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

const URL = "/api/myrmidon/bot-disk";
const HOUR = 60 * 60 * 1000;

/**
 * A settings row kept as stored JSON. Every read goes through the real
 * general-settings validator, the way the instance settings service reads it,
 * so a key the validator does not know (or a shape it rejects) is lost here
 * exactly as it would be in production.
 */
function settingsStore(initial: Record<string, unknown> = {}) {
  const row = { general: JSON.parse(JSON.stringify(initial)) as Record<string, unknown> };
  const read = () => {
    const parsed = instanceGeneralSettingsSchema.safeParse(row.general);
    if (!parsed.success) throw new Error(`general settings did not parse: ${parsed.error.message}`);
    return parsed.data as Record<string, unknown>;
  };
  return {
    row,
    port: {
      getGeneral: async () => read(),
      updateGeneral: async (patch: Record<string, unknown>) => {
        row.general = JSON.parse(JSON.stringify({ ...read(), ...patch }));
        return {};
      },
    } as unknown as BotDiskServiceDeps["settings"],
  };
}

function harness(options: { initial?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const store = settingsStore(options.initial);
  const audits: Array<Record<string, unknown>> = [];
  const deps = (): Partial<BotDiskServiceDeps> => ({
    settings: store.port,
    listCompanyIds: async () => [COMPANY_ID, OTHER_COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    env: options.env ?? {},
  });
  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    // A fresh service per app: nothing is remembered in memory between them.
    scoped.use("/api", botDiskRoutes({} as Db, botDiskService({} as Db, deps())));
    scoped.use(errorHandler);
    return scoped;
  };
  return { store, audits, withActor };
}

describe("myrmidon(BOT-DISK-A) bot disk settings: permissions", () => {
  it("lets a board member read", async () => {
    const h = harness();
    const res = await request(h.withActor(member)).get(URL).expect(200);
    expect(res.body).toEqual({
      settings: { enabled: true, idleTtlMs: BOT_DISK_DEFAULT_IDLE_TTL_MS },
      sources: { enabled: "default", idleTtlMs: "default" },
    });
  });

  it("refuses a board member without any organization access and agents on read", async () => {
    const h = harness();
    await request(h.withActor(outsider)).get(URL).expect(403);
    await request(h.withActor(agentActor)).get(URL).expect(403);
  });

  it("PATCH without instance admin is 403 and writes nothing", async () => {
    const h = harness();
    await request(h.withActor(member)).patch(URL).send({ idleTtlMs: 2 * HOUR }).expect(403);
    await request(h.withActor(agentActor)).patch(URL).send({ idleTtlMs: 2 * HOUR }).expect(403);
    await request(h.withActor(outsider)).patch(URL).send({ enabled: false }).expect(403);
    expect(h.store.row.general.botDisk).toBeUndefined();
    expect(h.audits).toEqual([]);
  });

  it("refuses values out of range or unknown keys and writes nothing", async () => {
    const h = harness();
    for (const body of [
      { idleTtlMs: 60_000 },
      { idleTtlMs: 31 * 24 * HOUR },
      { idleTtlMs: "6h" },
      { enabled: "yes" },
      { quota: { perBotMb: 1 } },
    ]) {
      await request(h.withActor(admin)).patch(URL).send(body).expect(400);
    }
    expect(h.store.row.general.botDisk).toBeUndefined();
    expect(h.audits).toEqual([]);
  });
});

describe("myrmidon(BOT-DISK-A) bot disk settings: persistence", () => {
  it("PATCH persists to general.botDisk and survives a fresh store/read", async () => {
    const h = harness();
    const res = await request(h.withActor(admin)).patch(URL).send({ idleTtlMs: 2 * HOUR }).expect(200);
    expect(res.body).toEqual({
      settings: { enabled: true, idleTtlMs: 2 * HOUR },
      sources: { enabled: "settings", idleTtlMs: "settings" },
    });
    expect(h.store.row.general.botDisk).toEqual({ enabled: true, idleTtlMs: 2 * HOUR });

    // A fresh service over a fresh store built from the stored JSON alone.
    const reopened = settingsStore(h.store.row.general);
    const fresh = await botDiskService({} as Db, { settings: reopened.port, env: {} }).read();
    expect(fresh.settings).toEqual({ enabled: true, idleTtlMs: 2 * HOUR });
    expect(fresh.sources).toEqual({ enabled: "settings", idleTtlMs: "settings" });

    // A later PATCH of one key keeps the other stored value.
    await request(h.withActor(admin)).patch(URL).send({ enabled: false }).expect(200);
    expect(h.store.row.general.botDisk).toEqual({ enabled: false, idleTtlMs: 2 * HOUR });
  });

  it("audits every change for every company, like the runtime limits", async () => {
    const h = harness();
    await request(h.withActor(admin)).patch(URL).send({ idleTtlMs: 3 * HOUR }).expect(200);
    expect(h.audits).toHaveLength(2);
    expect(h.audits.map((a) => a.companyId).sort()).toEqual([COMPANY_ID, OTHER_COMPANY_ID]);
    expect(h.audits[0]).toMatchObject({
      actorType: "user",
      actorId: "user-b",
      action: BOT_DISK_UPDATED_ACTION,
      entityType: "instance_settings",
      entityId: "bot-disk",
      details: {
        previous: { enabled: true, idleTtlMs: BOT_DISK_DEFAULT_IDLE_TTL_MS },
        next: { enabled: true, idleTtlMs: 3 * HOUR },
        changedKeys: ["idleTtlMs"],
      },
    });
  });

  it("an old row without the key still loads, with the other settings intact", async () => {
    const h = harness({
      initial: {
        keyboardShortcuts: true,
        hostDisk: { usageThresholdPercent: 70 },
      },
      env: { MYRMIDON_BOT_DISK_IDLE_TTL_MS: String(4 * HOUR) },
    });
    const res = await request(h.withActor(member)).get(URL).expect(200);
    expect(res.body).toEqual({
      settings: { enabled: true, idleTtlMs: 4 * HOUR },
      sources: { enabled: "default", idleTtlMs: "env" },
    });

    await request(h.withActor(admin)).patch(URL).send({ enabled: false }).expect(200);
    expect(h.store.row.general).toMatchObject({
      keyboardShortcuts: true,
      hostDisk: { usageThresholdPercent: 70 },
      botDisk: { enabled: false, idleTtlMs: 4 * HOUR },
    });
  });

  it("a hand-edited or legacy-shaped row still loads; invalid values fall back", async () => {
    const h = harness({
      initial: {
        keyboardShortcuts: true,
        botDisk: {
          lifecycle: { enabled: true, idleTtlMs: HOUR },
          quota: { defaultMb: 1024 },
          idleTtlMs: "six hours",
          enabled: false,
        },
      },
    });
    const res = await request(h.withActor(member)).get(URL).expect(200);
    expect(res.body).toEqual({
      settings: { enabled: false, idleTtlMs: BOT_DISK_DEFAULT_IDLE_TTL_MS },
      sources: { enabled: "settings", idleTtlMs: "default" },
    });

    const notAnObject = harness({ initial: { keyboardShortcuts: true, botDisk: "on" } });
    const again = await request(notAnObject.withActor(member)).get(URL).expect(200);
    expect(again.body.sources).toEqual({ enabled: "default", idleTtlMs: "default" });
  });
});

describe("myrmidon(BOT-DISK-A) the sweep reads the stored settings every tick", () => {
  it("a PATCH reaches the next sweep config without a restart", async () => {
    const h = harness({ env: {} });
    const before = await resolveBotDiskLifecycleConfig(h.store.port, {});
    expect(before).toEqual({
      enabled: true,
      idleTtlMs: BOT_DISK_DEFAULT_IDLE_TTL_MS,
      defaultIdleTtlMs: BOT_DISK_DEFAULT_IDLE_TTL_MS,
    });

    await request(h.withActor(admin)).patch(URL).send({ enabled: false, idleTtlMs: HOUR }).expect(200);
    const after = await resolveBotDiskLifecycleConfig(h.store.port, {});
    expect(after).toEqual({ enabled: false, idleTtlMs: HOUR, defaultIdleTtlMs: BOT_DISK_DEFAULT_IDLE_TTL_MS });
  });
});
