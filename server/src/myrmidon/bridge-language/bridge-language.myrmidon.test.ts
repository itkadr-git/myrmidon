// myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default
// language of the bridged Telegram DM.
//
// The precedence, the stored-shape reader, the short cache, the preserve helper
// (a vendor general write must not drop the setting), the PATCH audit and the
// route permissions are all exercised over fake ports, so this suite needs no
// database — the runtime-limits harness pattern.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  BRIDGE_LANGUAGE_ENV,
  BRIDGE_LANGUAGE_SETTINGS_KEY,
  DEFAULT_BRIDGE_LANGUAGE,
  readStoredBridgeLanguage,
  resolveBridgeLanguage,
} from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { bridgeLanguageRoutes } from "./routes.js";
import {
  BRIDGE_LANGUAGE_ACTION,
  bridgeLanguageService,
  type BridgeLanguageServiceDeps,
} from "./service.js";
import {
  invalidateBridgeLanguageSettingsCache,
  preserveBridgeLanguageGeneralKey,
  readBridgeLanguageSettings,
} from "./settings.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID_B = "33333333-3333-4333-8333-333333333333";

const adminActor = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: true,
  companyIds: [COMPANY_ID],
};
const memberActor = { ...adminActor, isInstanceAdmin: false };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

describe("myrmidon(1.6.5-TG-LOCALE-C) bridge language: the precedence", () => {
  it("forces the env language, then the stored setting, then English", () => {
    expect(resolveBridgeLanguage({ stored: { language: "ru" }, env: {} })).toEqual({
      language: "ru",
      source: "instance",
      forced: null,
      stored: "ru",
    });
    expect(
      resolveBridgeLanguage({ stored: { language: "ru" }, env: { [BRIDGE_LANGUAGE_ENV]: "en" } }),
    ).toEqual({ language: "en", source: "environment", forced: "en", stored: "ru" });
    expect(resolveBridgeLanguage({ stored: undefined, env: {} })).toEqual({
      language: DEFAULT_BRIDGE_LANGUAGE,
      source: "default",
      forced: null,
      stored: null,
    });
  });

  it("ignores an unknown forced value and a malformed stored value", () => {
    expect(resolveBridgeLanguage({ env: { [BRIDGE_LANGUAGE_ENV]: "de" } }).source).toBe("default");
    expect(resolveBridgeLanguage({ env: { [BRIDGE_LANGUAGE_ENV]: " EN " } }).language).toBe("en");
    expect(readStoredBridgeLanguage({ language: "de" })).toBeNull();
    expect(readStoredBridgeLanguage("ru")).toBeNull();
    expect(readStoredBridgeLanguage({})).toBeNull();
    expect(readStoredBridgeLanguage(undefined)).toBeNull();
    expect(readStoredBridgeLanguage({ language: "ru" })).toBe("ru");
  });
});

describe("myrmidon(1.6.5-TG-LOCALE-C) bridge language: the reader", () => {
  it("reads the stored value out of `general` and reuses it briefly", async () => {
    invalidateBridgeLanguageSettingsCache();
    let reads = 0;
    const deps = {
      getGeneral: async () => {
        reads += 1;
        return { [BRIDGE_LANGUAGE_SETTINGS_KEY]: { language: "ru" } };
      },
      env: {},
    };
    const first = await readBridgeLanguageSettings({ ...deps, cacheMs: 5_000 });
    const second = await readBridgeLanguageSettings({ ...deps, cacheMs: 5_000 });
    expect(first).toMatchObject({ language: "ru", source: "instance" });
    expect(second.language).toBe("ru");
    // The second read came from the cache, not from the row.
    expect(reads).toBe(1);
    invalidateBridgeLanguageSettingsCache();
    await readBridgeLanguageSettings({ ...deps, cacheMs: 5_000 });
    expect(reads).toBe(2);
    invalidateBridgeLanguageSettingsCache();
  });

  it("never fails a reply when the settings row cannot be read", async () => {
    invalidateBridgeLanguageSettingsCache();
    const resolved = await readBridgeLanguageSettings({
      getGeneral: async () => {
        throw new Error("db down");
      },
      env: {},
      cacheMs: 0,
    });
    expect(resolved).toEqual({
      language: DEFAULT_BRIDGE_LANGUAGE,
      source: "default",
      forced: null,
      stored: null,
    });
    // The env force still applies while the row is unreadable.
    const forced = await readBridgeLanguageSettings({
      getGeneral: async () => {
        throw new Error("db down");
      },
      env: { [BRIDGE_LANGUAGE_ENV]: "ru" },
      cacheMs: 0,
    });
    expect(forced.language).toBe("ru");
    expect(forced.source).toBe("environment");
  });

  it("preserves the stored key and invents nothing for a row without it", () => {
    expect(preserveBridgeLanguageGeneralKey({ [BRIDGE_LANGUAGE_SETTINGS_KEY]: { language: "ru" } })).toEqual({
      [BRIDGE_LANGUAGE_SETTINGS_KEY]: { language: "ru" },
    });
    expect(preserveBridgeLanguageGeneralKey({ ownerDelivery: {} })).toEqual({});
    expect(preserveBridgeLanguageGeneralKey(null)).toEqual({});
    expect(preserveBridgeLanguageGeneralKey("nope")).toEqual({});
  });
});

interface HarnessOptions {
  general?: Record<string, unknown>;
  companyIds?: string[];
  env?: Record<string, string | undefined>;
}

function harness(options: HarnessOptions = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  const general = { ...(options.general ?? {}) };

  const deps: Partial<BridgeLanguageServiceDeps> = {
    getGeneral: async () => ({ ...general }),
    updateGeneral: async (patch) => {
      writes.push(patch as unknown as Record<string, unknown>);
      general[BRIDGE_LANGUAGE_SETTINGS_KEY] = patch.bridgeLanguage;
      return undefined;
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID, COMPANY_ID_B],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    env: options.env ?? {},
  };

  const service = bridgeLanguageService({} as Db, deps);

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", bridgeLanguageRoutes({} as Db, service));
    scoped.use(errorHandler);
    return scoped;
  };

  return { app: withActor(adminActor), withActor, service, audits, writes, general };
}

const URL = "/api/myrmidon/bridge-language";

describe("myrmidon(1.6.5-TG-LOCALE-C) bridge language: the API", () => {
  it("reports the source to a board member (default, then the instance value)", async () => {
    const h = harness();
    const empty = await request(h.app).get(URL).expect(200);
    expect(empty.body).toEqual({ language: "en", source: "default", forced: null, stored: null });

    const h2 = harness({ general: { [BRIDGE_LANGUAGE_SETTINGS_KEY]: { language: "ru" } } });
    const stored = await request(h2.app).get(URL).expect(200);
    expect(stored.body).toEqual({ language: "ru", source: "instance", forced: null, stored: "ru" });

    const h3 = harness({
      general: { [BRIDGE_LANGUAGE_SETTINGS_KEY]: { language: "ru" } },
      env: { [BRIDGE_LANGUAGE_ENV]: "en" },
    });
    const forced = await request(h3.app).get(URL).expect(200);
    expect(forced.body).toEqual({ language: "en", source: "environment", forced: "en", stored: "ru" });
  });

  it("lets an instance admin change the language and audits it once per company", async () => {
    const h = harness();
    const res = await request(h.app).patch(URL).send({ language: "ru" }).expect(200);
    expect(res.body).toEqual({ language: "ru", source: "instance", forced: null, stored: "ru" });
    expect(h.writes).toEqual([{ bridgeLanguage: { language: "ru" } }]);
    expect(h.audits).toHaveLength(2);
    expect(h.audits[0]).toMatchObject({
      companyId: COMPANY_ID,
      action: BRIDGE_LANGUAGE_ACTION,
      entityType: "instance_settings",
      entityId: BRIDGE_LANGUAGE_SETTINGS_KEY,
      details: { patch: { language: "ru" } },
    });
    expect(h.audits[1]).toMatchObject({ companyId: COMPANY_ID_B });

    // The reader sees the new value at once (its cache is dropped on write).
    const after = await request(h.app).get(URL).expect(200);
    expect(after.body.language).toBe("ru");
    expect(after.body.source).toBe("instance");
  });

  it("keeps every key the row already had", async () => {
    const h = harness({ general: { ownerDelivery: { enabled: true } } });
    await request(h.app).patch(URL).send({ language: "ru" }).expect(200);
    expect(h.general).toEqual({
      ownerDelivery: { enabled: true },
      [BRIDGE_LANGUAGE_SETTINGS_KEY]: { language: "ru" },
    });
  });

  it("refuses a board member who is not an instance admin", async () => {
    const h = harness();
    await request(h.withActor(memberActor)).patch(URL).send({ language: "ru" }).expect(403);
    expect(h.writes).toEqual([]);
    expect(h.audits).toEqual([]);
    // Reading stays open to the board.
    await request(h.withActor(memberActor)).get(URL).expect(200);
  });

  it("refuses agents on read and write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(agentActor)).patch(URL).send({ language: "ru" }).expect(403);
    expect(h.writes).toEqual([]);
  });

  it("rejects an unknown language and a body without it", async () => {
    const h = harness();
    await request(h.app).patch(URL).send({ language: "de" }).expect(400);
    await request(h.app).patch(URL).send({}).expect(400);
    await request(h.app).patch(URL).send({ language: "ru", unexpected: 1 }).expect(400);
    expect(h.writes).toEqual([]);
  });
});