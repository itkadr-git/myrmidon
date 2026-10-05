// myrmidon(1.7-SETTINGS-TO-UI): the channel settings resolver, the patch
// validator and the routes.
//
// The routes run over the real service with fake ports (the settings row, the
// audit sink and the company list), so permissions, validation, the audit
// record and the stored document are all exercised without a database.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { channelSettingsRoutes } from "./routes.js";
import {
  CHANNEL_SETTINGS_ACTION,
  channelSettingsService,
  type ChannelSettingsServiceDeps,
} from "./service.js";
import { getEffectiveChannelSettings, parseChannelSettingsPatch } from "./settings.js";

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

interface HarnessOptions {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  companyIds?: string[];
}

function harness(options: HarnessOptions = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const writes: unknown[] = [];
  const current = { document: options.stored };

  const deps: Partial<ChannelSettingsServiceDeps> = {
    settings: {
      getGeneral: async () => ({ channelSettings: current.document }),
      updateGeneral: async (patch) => {
        current.document = patch.channelSettings;
        writes.push(patch.channelSettings);
        return {};
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    env: options.env ?? {},
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", channelSettingsRoutes({} as Db, channelSettingsService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };

  return { app: withActor(member), withActor, audits, writes, current };
}

const URL = "/api/myrmidon/channel-settings";

describe("myrmidon(1.7-SETTINGS-TO-UI) channel settings: resolving the document", () => {
  it("falls back to the built-in defaults with no stored value and no environment", () => {
    const settings = getEffectiveChannelSettings(null, {});
    expect(settings.telegramDmConversations.value).toBe("");
    expect(settings.telegramDmStatus.value).toBe(false);
    expect(settings.telegramSplitMaxParts.value).toBe(0);
    expect(settings.telegramFileLimitBytes.value).toBe(10 * 1024 * 1024);
    expect(settings.paperclipAttachmentMaxBytes.value).toBe(10 * 1024 * 1024);
    expect(settings.chatCrossChannelMessages.value).toBe(12);
    expect(settings.chatCrossChannelMessageChars.value).toBe(600);
    expect(settings.chatCrossChannelTotalChars.value).toBe(4000);
    expect(settings.chatCrossChannelLookbackHours.value).toBe(168);
    expect(settings.chatReconcileIntervalMs.value).toBeNull();
    expect(settings.telegramApiBaseUrl.value).toBeNull();
    expect(Object.values(settings).map((entry) => entry.source)).toEqual(Array(11).fill("default"));
  });

  it("reads the environment and marks those keys as overridden", () => {
    const settings = getEffectiveChannelSettings(null, {
      MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "bot-a,bot-b",
      MYRMIDON_TELEGRAM_DM_STATUS: "yes",
      MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS: "5",
      MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES: "20",
      MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "30000",
      TELEGRAM_API_BASE_URL: "http://127.0.0.1:8081",
    });
    expect(settings.telegramDmConversations.value).toBe("bot-a,bot-b");
    expect(settings.telegramDmStatus.value).toBe(true);
    expect(settings.telegramSplitMaxParts.value).toBe(5);
    expect(settings.chatCrossChannelMessages.value).toBe(20);
    expect(settings.chatReconcileIntervalMs.value).toBe(30000);
    expect(settings.chatCrossChannelMessageChars.value).toBe(600);
    expect(settings.telegramDmConversations.source).toBe("env");
    expect(settings.telegramDmConversations.overridden).toBe(true);
    expect(settings.chatCrossChannelMessageChars.source).toBe("default");
    expect(settings.chatCrossChannelMessageChars.overridden).toBe(false);
    expect(settings.telegramApiBaseUrl.value).toBe("http://127.0.0.1:8081");
  });

  it("reports a stored value as the ui source, and the environment still wins over it", () => {
    const stored = { channel: { telegramSplitMaxParts: 5, telegramDmConversations: "bot-a" } };
    const withoutEnv = getEffectiveChannelSettings(stored, {});
    expect(withoutEnv.telegramSplitMaxParts.value).toBe(5);
    expect(withoutEnv.telegramSplitMaxParts.source).toBe("ui");
    expect(withoutEnv.telegramSplitMaxParts.overridden).toBe(false);
    expect(withoutEnv.telegramDmConversations.value).toBe("bot-a");

    const withEnv = getEffectiveChannelSettings(stored, { MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS: "9" });
    expect(withEnv.telegramSplitMaxParts.value).toBe(9);
    expect(withEnv.telegramSplitMaxParts.source).toBe("env");
    expect(withEnv.telegramSplitMaxParts.overridden).toBe(true);
    // The key the environment does not pin keeps the stored value.
    expect(withEnv.telegramDmConversations.value).toBe("bot-a");
    expect(withEnv.telegramDmConversations.source).toBe("ui");
  });

  it("tolerates malformed values, falling back instead of refusing to resolve", () => {
    const settings = getEffectiveChannelSettings(
      { channel: { chatCrossChannelMessages: -5, chatReconcileIntervalMs: 0, telegramDmStatus: "maybe" } },
      { MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS: "not-a-number", MYRMIDON_TELEGRAM_DM_STATUS: "invalid" },
    );
    expect(settings.chatCrossChannelMessages.value).toBe(12);
    expect(settings.chatReconcileIntervalMs.value).toBeNull();
    expect(settings.chatCrossChannelMessageChars.value).toBe(600);
    expect(settings.telegramDmStatus.value).toBe(false);
  });

  it("reads booleans in the spellings the deployment already uses", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on"]) {
      expect(getEffectiveChannelSettings(null, { MYRMIDON_TELEGRAM_DM_STATUS: on }).telegramDmStatus.value).toBe(true);
    }
    for (const off of ["0", "false", "no", "off", "maybe", ""]) {
      expect(getEffectiveChannelSettings(null, { MYRMIDON_TELEGRAM_DM_STATUS: off }).telegramDmStatus.value).toBe(false);
    }
  });
});
describe("myrmidon(1.7-SETTINGS-TO-UI) channel settings: the patch validator", () => {
  it("accepts the writable keys and rejects an unknown one", () => {
    expect(parseChannelSettingsPatch({ telegramDmStatus: true, chatReconcileIntervalMs: null })).toEqual({
      telegramDmStatus: true,
      chatReconcileIntervalMs: null,
    });
    expect(() => parseChannelSettingsPatch({ telegramApiBaseUrl: "http://x" })).toThrow(/unknown channel setting/);
    expect(() => parseChannelSettingsPatch({ notASetting: 1 })).toThrow(/unknown channel setting/);
  });

  it("rejects a value of the wrong type", () => {
    expect(() => parseChannelSettingsPatch({ telegramDmStatus: "yes" })).toThrow(/must be a boolean/);
    expect(() => parseChannelSettingsPatch({ telegramSplitMaxParts: -1 })).toThrow(/non-negative integer/);
    expect(() => parseChannelSettingsPatch({ chatReconcileIntervalMs: 0 })).toThrow(/positive integer or null/);
    expect(() => parseChannelSettingsPatch({ telegramDmConversations: 5 })).toThrow(/must be a string/);
    expect(() => parseChannelSettingsPatch(null)).toThrow(/JSON object/);
  });
});

describe("myrmidon(1.7-SETTINGS-TO-UI) channel settings: the routes", () => {
  it("serves the effective settings to a board member", async () => {
    const { app } = harness({ env: { MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS: "7" } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.telegramSplitMaxParts).toEqual({
      value: 7,
      source: "env",
      default: 0,
      envName: "MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS",
      overridden: true,
    });
  });

  it("refuses a reader outside the company", async () => {
    const { withActor } = harness();
    await request(withActor(outsider)).get(URL).expect(403);
  });

  it("writes the document, audits it once per company, and answers with the values in force", async () => {
    const { withActor, audits, writes, current } = harness({
      companyIds: [COMPANY_ID, "33333333-3333-4333-8333-333333333333"],
    });
    const res = await request(withActor(admin))
      .patch(URL)
      .send({ telegramDmConversations: "bot-a,bot-b", chatCrossChannelMessages: 20 })
      .expect(200);

    expect(writes).toEqual([
      { channel: { telegramDmConversations: "bot-a,bot-b", chatCrossChannelMessages: 20 } },
    ]);
    expect(current.document).toEqual({
      channel: { telegramDmConversations: "bot-a,bot-b", chatCrossChannelMessages: 20 },
    });
    expect(res.body.telegramDmConversations.value).toBe("bot-a,bot-b");
    expect(res.body.telegramDmConversations.source).toBe("ui");
    expect(res.body.chatCrossChannelMessages.value).toBe(20);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: CHANNEL_SETTINGS_ACTION,
      entityType: "instance_settings",
      entityId: "channelSettings",
      details: { changedKeys: ["telegramDmConversations", "chatCrossChannelMessages"] },
    });
  });

  it("keeps the environment value in force while storing the patch, and marks it overridden", async () => {
    const { withActor, current } = harness({ env: { MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES: "3" } });
    const res = await request(withActor(admin)).patch(URL).send({ chatCrossChannelMessages: 20 }).expect(200);
    expect(res.body.chatCrossChannelMessages.value).toBe(3);
    expect(res.body.chatCrossChannelMessages.source).toBe("env");
    expect(res.body.chatCrossChannelMessages.overridden).toBe(true);
    expect(current.document).toEqual({ channel: { chatCrossChannelMessages: 20 } });
  });

  it("requires an instance admin to write", async () => {
    const { withActor, writes } = harness();
    await request(withActor(member)).patch(URL).send({ telegramDmStatus: true }).expect(403);
    expect(writes).toEqual([]);
  });

  it("answers 400 for an unknown or malformed field", async () => {
    const { withActor, writes } = harness();
    await request(withActor(admin)).patch(URL).send({ telegramApiBaseUrl: "http://x" }).expect(400);
    await request(withActor(admin)).patch(URL).send({ telegramDmStatus: "yes" }).expect(400);
    expect(writes).toEqual([]);
  });
});
