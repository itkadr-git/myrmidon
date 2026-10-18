// Watchdog tests of the Telegram channel connector (chat-provider-telegram).
// Task: OPE-6960 (OPE-4956 part C). Design: docs/myrmidon/design/chat-channel-
// connector.md, sections 3.1-3.4.
//
// What is pinned here: the connector answers the full contract, the flag is the
// only way it reaches the registry, the conversation key is identical to the
// vendor's, the addressed gate keeps a group silent without a configured bot,
// inbound and outbound messages pass through the contract end to end, and the
// plan reuses the vendor splitter. No vendor file, no database: the store seam
// is a fixture.

import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_CONNECTOR_AREAS } from "./contract.js";
import type {
  ChannelConnectorContext,
  ChannelConnectorStore,
  ChannelEndpointView,
  ChannelLogSink,
  ChannelPublication,
  ChannelTransportSink,
  ChannelTurn,
  TransportPart,
} from "./contract.js";
import {
  getChannelConnector,
  getChannelConnectorFactory,
  unregisterChannelConnector,
} from "./registry.js";
import {
  TELEGRAM_BOT_USERNAME_ENV,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_CHAT_PROVIDER_ENV,
  TELEGRAM_CONNECTOR_PROVIDER,
  TELEGRAM_FILE_LIMIT_BYTES,
  createTelegramChannelConnector,
  installTelegramChannelConnector,
  telegramAddressedToBot,
  telegramChannelStatusFor,
  telegramChatProviderFlagEnabled,
  telegramConnectorFactory,
  telegramConversationKeyOf,
} from "./telegram.js";

const ENDPOINT: ChannelEndpointView = {
  id: "endpoint-1",
  companyId: "company-1",
  provider: "telegram",
  publicId: "tg-public-1",
  status: "connected",
};

const store: ChannelConnectorStore = {
  readEndpoint: async (endpointId) =>
    endpointId === ENDPOINT.id ? ENDPOINT : null,
};

const silent: ChannelLogSink = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function context(_env: Record<string, string | undefined> = {}): ChannelConnectorContext {
  return {
    companyId: ENDPOINT.companyId,
    store,
    logger: silent,
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  };
}

function connectorOf(env: Record<string, string | undefined> = {}) {
  return createTelegramChannelConnector({ store, logger: silent, now: () => new Date() }, { env });
}

function update(message: Record<string, unknown>): Record<string, unknown> {
  return { update_id: 7, message };
}

const privateMessage = {
  chat: { id: 5001, type: "private" },
  from: { id: 5001, username: "user_one" },
  message_id: 11,
  text: "hello the board",
  date: 1_760_000_000,
};

describe("telegram connector: the flag and the registry", () => {
  afterEach(() => {
    unregisterChannelConnector(TELEGRAM_CONNECTOR_PROVIDER);
  });

  it("is off by default and by typo: nothing is installed", () => {
    expect(telegramChatProviderFlagEnabled({})).toBe(false);
    expect(telegramChatProviderFlagEnabled({ [TELEGRAM_CHAT_PROVIDER_ENV]: "" })).toBe(false);
    expect(telegramChatProviderFlagEnabled({ [TELEGRAM_CHAT_PROVIDER_ENV]: "0" })).toBe(false);
    expect(telegramChatProviderFlagEnabled({ [TELEGRAM_CHAT_PROVIDER_ENV]: "ture" })).toBe(false);
    expect(installTelegramChannelConnector({})).toBe(false);
    expect(getChannelConnectorFactory(TELEGRAM_CONNECTOR_PROVIDER)).toBeNull();
  });

  it("installs only the telegram provider when the flag is on", () => {
    expect(
      telegramChatProviderFlagEnabled({ [TELEGRAM_CHAT_PROVIDER_ENV]: "1" }),
    ).toBe(true);
    for (const on of ["true", "yes", "on"]) {
      expect(telegramChatProviderFlagEnabled({ [TELEGRAM_CHAT_PROVIDER_ENV]: on })).toBe(true);
    }
    expect(
      installTelegramChannelConnector({ [TELEGRAM_CHAT_PROVIDER_ENV]: "1" }),
    ).toBe(true);
    const connector = getChannelConnector(TELEGRAM_CONNECTOR_PROVIDER, {
      store,
      logger: silent,
      now: () => new Date(),
    });
    expect(connector).not.toBeNull();
    expect(connector?.provider).toBe("telegram");
    // Installing twice is a no-op, not a startup crash.
    expect(
      installTelegramChannelConnector({ [TELEGRAM_CHAT_PROVIDER_ENV]: "1" }),
    ).toBe(true);
    // The other providers stay unregistered — the switch touches only telegram.
    expect(getChannelConnectorFactory("discord")).toBeNull();
    expect(getChannelConnectorFactory("slack")).toBeNull();
  });

  it("the factory of the registry builds the same connector", () => {
    unregisterChannelConnector(TELEGRAM_CONNECTOR_PROVIDER);
    expect(telegramConnectorFactory({ store, logger: silent, now: () => new Date() }).provider).toBe(
      TELEGRAM_CONNECTOR_PROVIDER,
    );
  });
});

describe("telegram connector: the contract shape", () => {
  it("carries every area and member of CHANNEL_CONNECTOR_AREAS", () => {
    const connector = connectorOf();
    for (const [area, members] of Object.entries(CHANNEL_CONNECTOR_AREAS)) {
      if (area === "provider") {
        expect(connector.provider).toBe("telegram");
        continue;
      }
      const part = (connector as unknown as Record<string, unknown>)[area];
      expect(part, `area ${area} must exist`).toBeTypeOf("object");
      for (const member of members) {
        expect(
          (part as Record<string, unknown>)[member],
          `${area}.${member} must exist`,
        ).toBeDefined();
      }
    }
  });

  it("carries the Telegram media limits", () => {
    const media = connectorOf().media;
    expect(media.captionLimit).toBe(TELEGRAM_CAPTION_LIMIT);
    expect(media.fileLimitBytes).toBe(TELEGRAM_FILE_LIMIT_BYTES);
    expect(media.accepts).toContain("photo");
    expect(media.accepts).toContain("voice");
  });

  it("declares its settings keys with the env names", () => {
    const keys = connectorOf().settings.keys.map((k) => `${k.key}:${k.envVar}`);
    expect(keys).toContain(`telegram.chatProvider.enabled:${TELEGRAM_CHAT_PROVIDER_ENV}`);
    expect(keys).toContain(`telegram.botUsername:${TELEGRAM_BOT_USERNAME_ENV}`);
  });
});

describe("telegram connector: links", () => {
  it("the conversation key matches the vendor's key exactly", () => {
    expect(telegramConversationKeyOf(update(privateMessage))).toBe("telegram:5001");
    expect(
      telegramConversationKeyOf(
        update({ ...privateMessage, chat: { id: -100234, type: "supergroup" }, message_thread_id: 99 }),
      ),
    ).toBe("telegram:-100234:99");
    // An event the connector cannot read answers with the empty key.
    expect(telegramConversationKeyOf(null)).toBe("");
    expect(telegramConversationKeyOf({ callback_query: { id: "x" } })).toBe("");
    expect(telegramConversationKeyOf(update({ chat: {} }))).toBe("");
  });

  it("conversationUrl stays null until the link seam opens", () => {
    expect(
      connectorOf().links.conversationUrl({
        endpointId: ENDPOINT.id,
        conversationKey: "telegram:5001",
        externalId: null,
      }),
    ).toBeNull();
  });

  it("route answers null and bind does not throw (no traffic switch in this step)", async () => {
    const connector = connectorOf();
    const ctx = context({});
    expect(await connector.links.route(update(privateMessage), ctx)).toBeNull();
    await expect(
      connector.links.bind(
        { endpointId: ENDPOINT.id, conversationKey: "telegram:5001", externalId: null },
        { endpointId: ENDPOINT.id, companyId: ENDPOINT.companyId, conversationKey: "telegram:5001", issueId: null, agentId: null },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("telegram connector: inbound", () => {
  it("normalizes a private message through the contract", async () => {
    const connector = connectorOf();
    const turn = await connector.inbound.normalize(update(privateMessage), context({}));
    expect(turn).not.toBeNull();
    expect(turn?.provider).toBe("telegram");
    expect(turn?.conversationKey).toBe("telegram:5001");
    expect(turn?.authorExternalId).toBe("5001");
    expect(turn?.text).toBe("hello the board");
    expect(turn?.addressedToBot).toBe(true);
    expect(turn?.raw).toEqual(update(privateMessage));
  });

  it("reads an edited message and a caption, ignores other updates", async () => {
    const connector = connectorOf();
    const edited = { update_id: 8, edited_message: { ...privateMessage, text: "edited" } };
    const turn = await connector.inbound.normalize(edited, context({}));
    expect(turn?.text).toBe("edited");
    const caption = update({ ...privateMessage, text: undefined, photo: [{ file_id: "s" }, { file_id: "b", file_unique_id: "u1", file_size: 900, mime_type: "image/jpeg" }] });
    const photoTurn = await connector.inbound.normalize(caption, context({}));
    expect(photoTurn?.media).toEqual([
      { kind: "photo", externalId: "u1", fileName: null, mimeType: "image/jpeg", sizeBytes: 900 },
    ]);
    expect(await connector.inbound.normalize({ callback_query: { id: "x" } }, context({}))).toBeNull();
    expect(await connector.inbound.normalize("not an update", context({}))).toBeNull();
  });

  it("the group gate: silent without a bot username, admitted on a mention", () => {
    const group = { chat: { id: -100234, type: "supergroup" }, from: { id: 9 }, message_id: 3, text: "ping", date: 1 };
    expect(telegramAddressedToBot(group, null)).toBe(false);
    expect(telegramAddressedToBot(group, "board_bot")).toBe(false);
    expect(telegramAddressedToBot({ ...group, text: "@Board_Bot ping" }, "board_bot")).toBe(true);
    expect(
      telegramAddressedToBot(
        { ...group, text: "ping" },
        "board_bot",
      ) === false,
    ).toBe(true);
    // an entity mention also counts
    expect(
      telegramAddressedToBot(
        { ...group, text: "ping there", entities: [{ type: "mention", text: "@board_bot", offset: 12, length: 10 }] },
        "board_bot",
      ),
    ).toBe(true);
  });

  it("admits the turn only when the flag is on and the bot is addressed", async () => {
    const connector = connectorOf({ [TELEGRAM_CHAT_PROVIDER_ENV]: "1", [TELEGRAM_BOT_USERNAME_ENV]: "board_bot" });
    const ctx = context({});
    const off = connectorOf({});
    const groupTurn = await off.inbound.normalize(update({ chat: { id: -100234, type: "supergroup" }, from: { id: 9 }, message_id: 3, text: "ping" }), ctx);
    expect(groupTurn).not.toBeNull();
    expect((await off.inbound.admit(groupTurn as ChannelTurn, ctx)).admitted).toBe(false);
    expect((await off.inbound.admit(groupTurn as ChannelTurn, ctx)).reason).toBe("disabled");
    // flag on, not addressed in a group → not-addressed
    expect(await connector.inbound.admit(groupTurn as ChannelTurn, ctx)).toEqual({
      admitted: false,
      reason: "not-addressed",
    });
    const privateTurn = (await connector.inbound.normalize(update(privateMessage), ctx)) as ChannelTurn;
    expect(await connector.inbound.admit(privateTurn, ctx)).toEqual({ admitted: true, reason: null });
  });

  it("intake accepts within the limits and reports why a piece was refused", async () => {
    const connector = connectorOf();
    const turn = {
      endpointId: "",
      provider: "telegram",
      conversationKey: "telegram:5001",
      conversationUrl: null,
      authorExternalId: "5001",
      addressedToBot: true,
      text: "",
      media: [
        { kind: "photo", externalId: "ok", fileName: null, mimeType: "image/jpeg", sizeBytes: 1024 },
        { kind: "document", externalId: "big", fileName: "movie.mkv", mimeType: null, sizeBytes: TELEGRAM_FILE_LIMIT_BYTES + 1 },
      ],
      receivedAt: new Date(),
      raw: null,
    } as unknown as ChannelTurn;
    const result = await connector.inbound.intakeMedia(turn, context({}));
    expect(result.intake.map((m) => m.externalId)).toEqual(["ok"]);
    expect(result.rejected).toEqual([
      { media: turn.media[1], reason: "too-large" },
    ]);
    expect(result.accepted).toBe(false);
  });
});

describe("telegram connector: outbound", () => {
  function publication(text: string, media: ChannelTurn["media"] = []): ChannelPublication {
    return {
      endpointId: ENDPOINT.id,
      companyId: ENDPOINT.companyId,
      conversationKey: "telegram:5001",
      idempotencyKey: "idem-1",
      text,
      media,
      replyToExternalId: null,
    };
  }

  it("plans one text part for a short publication and sends it through the sink", async () => {
    const connector = connectorOf();
    const ctx = context({});
    const plan = await connector.outbound.plan(publication("short answer"), ctx);
    expect(plan.parts).toEqual([{ kind: "text", text: "short answer", media: null }]);
    const sentParts: TransportPart[] = [];
    const transport: ChannelTransportSink = {
      sendPart: async (part) => {
        sentParts.push(part);
        return { externalMessageId: `tg-${sentParts.length}` };
      },
    };
    const result = await connector.outbound.send(plan, transport, ctx);
    expect(result.delivered).toBe(true);
    expect(result.failedPartIndex).toBeNull();
    expect(result.externalMessageIds).toEqual(["tg-1"]);
    expect(sentParts).toEqual(plan.parts);
  });

  it("splits a long publication with the vendor splitter rule", async () => {
    const connector = connectorOf();
    const long = "word ".repeat(2000).trim(); // over the single-message ceiling
    const plan = await connector.outbound.plan(publication(long), context({}));
    expect(plan.parts.length).toBeGreaterThan(1);
    const rejoined = plan.parts.map((p) => p.text ?? "").join("");
    expect(rejoined.replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
    for (const part of plan.parts) {
      expect(part.kind).toBe("text");
      expect(Array.from(part.text ?? "").length).toBeLessThanOrEqual(1_600);
    }
  });

  it("plans the media after the text and keeps one idempotency key", async () => {
    const connector = connectorOf();
    const media = [
      { kind: "photo" as const, externalId: "u1", fileName: null, mimeType: null, sizeBytes: null },
    ];
    const plan = await connector.outbound.plan(publication("caption", media), context({}));
    expect(plan.idempotencyKey).toBe("idem-1");
    expect(plan.parts.map((p) => p.kind)).toEqual(["text", "media"]);
    expect(plan.parts[1]?.media).toEqual(media[0]);
  });

  it("an empty publication still leaves one sendable part", async () => {
    const plan = await connectorOf().outbound.plan(publication(""), context({}));
    expect(plan.parts).toEqual([{ kind: "text", text: "", media: null }]);
  });

  it("a failed part stops the send and reports the index", async () => {
    const connector = connectorOf();
    const transport: ChannelTransportSink = {
      sendPart: async (part) => {
        if (part.kind === "media") throw new Error("telegram api 400");
        return { externalMessageId: "tg-1" };
      },
    };
    const plan = await connector.outbound.plan(
      publication("answer", [{ kind: "document", externalId: "d1", fileName: null, mimeType: null, sizeBytes: null }]),
      context({}),
    );
    const result = await connector.outbound.send(plan, transport, context({}));
    expect(result.delivered).toBe(false);
    expect(result.failedPartIndex).toBe(1);
    expect(result.externalMessageIds).toEqual(["tg-1"]);
  });
});

describe("telegram connector: lifecycle and settings", () => {
  it("start records the runtime, stop drops it, status reads the vendor row", async () => {
    const connector = connectorOf();
    const ctx = context({});
    const runtime = await connector.lifecycle.start(ENDPOINT, ctx);
    expect(runtime).toEqual({
      endpointId: ENDPOINT.id,
      provider: "telegram",
      status: "ready",
      leaseKey: null,
    });
    expect(await connector.lifecycle.status(ENDPOINT, ctx)).toBe("ready");
    await connector.lifecycle.stop(ENDPOINT, "disabled", ctx);
    expect(await connector.lifecycle.status(ENDPOINT, ctx)).toBe("ready"); // the row still says connected
  });

  it("the vendor row status translates; unknown stays connecting", () => {
    expect(telegramChannelStatusFor("connected")).toBe("ready");
    expect(telegramChannelStatusFor("paused")).toBe("disabled");
    expect(telegramChannelStatusFor("disabled")).toBe("disabled");
    expect(telegramChannelStatusFor("error")).toBe("degraded");
    expect(telegramChannelStatusFor("something_new")).toBe("connecting");
  });

  it("settings resolve the environment with its source, the default otherwise", async () => {
    const resolved = await connectorOf({
      [TELEGRAM_CHAT_PROVIDER_ENV]: "1",
      [TELEGRAM_BOT_USERNAME_ENV]: "@board_bot",
    }).settings.resolve(context({}));
    expect(resolved.values["telegram.chatProvider.enabled"]).toBe(true);
    expect(resolved.sources["telegram.chatProvider.enabled"]).toBe("env");
    expect(resolved.values["telegram.botUsername"]).toBe("board_bot");
    const defaults = await connectorOf({}).settings.resolve(context({}));
    expect(defaults.values["telegram.chatProvider.enabled"]).toBe(false);
    expect(defaults.sources["telegram.chatProvider.enabled"]).toBe("default");
    expect(defaults.values["telegram.botUsername"]).toBeNull();
    // a typo keeps the off default rather than flipping the channel on
    const typo = await connectorOf({ [TELEGRAM_CHAT_PROVIDER_ENV]: "ture" }).settings.resolve(context({}));
    expect(typo.values["telegram.chatProvider.enabled"]).toBe(false);
  });
});
