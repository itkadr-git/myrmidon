import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { poolChatRoutes } from "./routes.js";
import type { PoolChatService } from "./service.js";
import type { TelegramOutboxSender } from "./telegram-bridge.js";
import type { ChannelSettingsService } from "../channel-settings/service.js";
import { getEffectiveChannelSettings } from "../channel-settings/settings.js";

function createMockPoolService(impl?: (args: any) => Promise<any>): PoolChatService {
  return {
    capabilities: vi.fn(async () => ({ models: ["balanced", "gemini-2.0-flash"] })),
    submit: vi.fn(
      impl ??
        (async (args: any) => ({
          request: {
            id: "req-1",
            status: "completed" as const,
            result: { text: `Reply to ${args.body?.messages?.[0]?.content ?? ""}` },
          },
          result: { text: `Reply to ${args.body?.messages?.[0]?.content ?? ""}` },
          replayed: false,
        })),
    ),
    status: vi.fn(),
  } as unknown as PoolChatService;
}

function createHarness(options?: {
  storedSettings?: Record<string, unknown>;
  env?: Record<string, string>;
  sender?: TelegramOutboxSender;
  service?: PoolChatService;
}) {
  const app = express();
  app.use(express.json());

  let currentStored = options?.storedSettings ?? {};
  const settingsService: ChannelSettingsService = {
    read: vi.fn(async () =>
      getEffectiveChannelSettings({ channel: currentStored }, options?.env ?? {}),
    ),
    update: vi.fn(async (patch) => {
      currentStored = { ...currentStored, ...patch };
      return getEffectiveChannelSettings({ channel: currentStored }, options?.env ?? {});
    }),
  };

  const poolService = options?.service ?? createMockPoolService();
  const mockSender: TelegramOutboxSender =
    options?.sender ?? vi.fn(async () => ({ ok: true, messageId: 777 }));

  const dummyDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{ id: "test-company-id" }]),
      })),
    })),
  } as any;

  const dummyResolver = vi.fn() as any;

  const router = poolChatRoutes(dummyDb, dummyResolver, {
    service: poolService,
    channelSettingsService: settingsService,
    sender: mockSender,
    env: options?.env,
    defaultCompanyId: "test-company-id",
  });

  app.use("/api", router);

  return {
    app,
    poolService,
    mockSender,
    settingsService,
  };
}

describe("Telegram pool bridge webhook routes (/api/myrmidon/pool-chat/modules/:moduleId/telegram/webhook)", () => {
  describe("ChatGPT pool bridge", () => {
    it("returns bridge_disabled when ChatGPT bridge is disabled by default", async () => {
      const { app, poolService, mockSender } = createHarness({
        storedSettings: { telegramPoolChatGptEnabled: false },
      });

      const res = await request(app)
        .post("/api/myrmidon/pool-chat/modules/chatgpt-pool/telegram/webhook")
        .send({
          update_id: 1001,
          message: {
            message_id: 1,
            chat: { id: 123456789 },
            text: "ping",
          },
        })
        .expect(200);

      expect(res.body).toEqual({
        status: "ignored",
        reason: "bridge_disabled",
        updateId: 1001,
      });
      expect(poolService.submit).not.toHaveBeenCalled();
      expect(mockSender).not.toHaveBeenCalled();
    });

    it("fails closed when enabled but allowedChatId is empty", async () => {
      const { app, poolService, mockSender } = createHarness({
        storedSettings: {
          telegramPoolChatGptEnabled: true,
          telegramPoolChatGptChatId: "", // empty
        },
      });

      const res = await request(app)
        .post("/api/myrmidon/pool-chat/modules/chatgpt-pool/telegram/webhook")
        .send({
          update_id: 1002,
          message: {
            message_id: 1,
            chat: { id: 123456789 },
            text: "hello",
          },
        })
        .expect(200);

      expect(res.body).toEqual({
        status: "refused",
        reason: "chat_not_allowed",
        updateId: 1002,
        chatId: 123456789,
      });
      expect(poolService.submit).not.toHaveBeenCalled();
      expect(mockSender).not.toHaveBeenCalled();
    });

    it("refuses updates from unauthorized chats (чужой чат)", async () => {
      const { app, poolService, mockSender } = createHarness({
        storedSettings: {
          telegramPoolChatGptEnabled: true,
          telegramPoolChatGptChatId: "123456789",
        },
      });

      const res = await request(app)
        .post("/api/myrmidon/pool-chat/modules/chatgpt-pool/telegram/webhook")
        .send({
          update_id: 1003,
          message: {
            message_id: 1,
            chat: { id: 999999999 }, // foreign chat
            text: "unauthorized ping",
          },
        })
        .expect(200);

      expect(res.body).toEqual({
        status: "refused",
        reason: "chat_not_allowed",
        updateId: 1003,
        chatId: 999999999,
      });
      expect(poolService.submit).not.toHaveBeenCalled();
      expect(mockSender).not.toHaveBeenCalled();
    });

    it("accepts updates from allowed chat (разрешённый чат) and dispatches reply", async () => {
      const { app, poolService, mockSender } = createHarness({
        storedSettings: {
          telegramPoolChatGptEnabled: true,
          telegramPoolChatGptChatId: "123456789",
          telegramPoolChatGptModel: "balanced",
          telegramPoolChatGptBotToken: "test-token-chatgpt",
        },
      });

      const res = await request(app)
        .post("/api/myrmidon/pool-chat/modules/chatgpt-pool/telegram/webhook")
        .send({
          update_id: 1004,
          message: {
            message_id: 10,
            chat: { id: 123456789 },
            text: "hello chatgpt",
          },
        })
        .expect(200);

      expect(res.body.status).toBe("delivered");
      expect(res.body.updateId).toBe(1004);
      expect(res.body.outboxItem?.status).toBe("delivered");

      expect(poolService.submit).toHaveBeenCalledTimes(1);
      const submitCall = vi.mocked(poolService.submit).mock.calls[0][0];
      expect(submitCall.companyId).toBe("test-company-id");
      expect(submitCall.channel).toBe("telegram");
      expect(submitCall.body.model).toBe("balanced");

      expect(mockSender).toHaveBeenCalledTimes(1);
      const senderCall = vi.mocked(mockSender).mock.calls[0][0];
      expect(senderCall.chatId).toBe(123456789);
      expect(senderCall.replyToMessageId).toBe(10);
      expect(senderCall.botToken).toBe("test-token-chatgpt");
    });

    it("deduplicates identical update_id (дедуп) without re-submitting or re-sending", async () => {
      const { app, poolService, mockSender } = createHarness({
        storedSettings: {
          telegramPoolChatGptEnabled: true,
          telegramPoolChatGptChatId: "123456789",
        },
      });

      const payload = {
        update_id: 1005,
        message: {
          message_id: 11,
          chat: { id: 123456789 },
          text: "hello deduplication",
        },
      };

      // First delivery
      const res1 = await request(app)
        .post("/api/myrmidon/pool-chat/modules/chatgpt-pool/telegram/webhook")
        .send(payload)
        .expect(200);
      expect(res1.body.status).toBe("delivered");
      expect(poolService.submit).toHaveBeenCalledTimes(1);
      expect(mockSender).toHaveBeenCalledTimes(1);

      // Duplicate delivery (retry from Telegram)
      const res2 = await request(app)
        .post("/api/myrmidon/pool-chat/modules/chatgpt-pool/telegram/webhook")
        .send(payload)
        .expect(200);
      expect(res2.body.status).toBe("deduplicated");
      expect(res2.body.reason).toBe("update_already_processed");
      expect(res2.body.updateId).toBe(1005);
      expect(poolService.submit).toHaveBeenCalledTimes(1); // not called again
      expect(mockSender).toHaveBeenCalledTimes(1); // not sent again
    });
  });

  describe("Gemini pool bridge (google-ai-pool)", () => {
    it("handles Gemini pool updates with isolated configuration and model", async () => {
      const { app, poolService, mockSender } = createHarness({
        storedSettings: {
          telegramPoolGeminiEnabled: true,
          telegramPoolGeminiChatId: "555555",
          telegramPoolGeminiModel: "gemini-2.0-flash",
          telegramPoolGeminiBotToken: "test-token-gemini",
        },
      });

      const res = await request(app)
        .post("/api/myrmidon/pool-chat/modules/google-ai-pool/telegram/webhook")
        .send({
          update_id: 2001,
          message: {
            message_id: 50,
            chat: { id: 555555 },
            text: "hello gemini",
          },
        })
        .expect(200);

      expect(res.body.status).toBe("delivered");
      expect(res.body.updateId).toBe(2001);

      expect(poolService.submit).toHaveBeenCalledTimes(1);
      const submitCall = vi.mocked(poolService.submit).mock.calls[0][0];
      expect(submitCall.body.model).toBe("gemini-2.0-flash");

      expect(mockSender).toHaveBeenCalledTimes(1);
      const senderCall = vi.mocked(mockSender).mock.calls[0][0];
      expect(senderCall.chatId).toBe(555555);
      expect(senderCall.botToken).toBe("test-token-gemini");
    });
  });

  it("returns 404 for unknown modules", async () => {
    const { app } = createHarness();
    const res = await request(app)
      .post("/api/myrmidon/pool-chat/modules/unknown-module/telegram/webhook")
      .send({ update_id: 1 })
      .expect(404);
    expect(res.body).toEqual({ error: "unknown_module" });
  });
});
