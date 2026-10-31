import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramPoolBridge,
  redactSecret,
  splitTelegramMessageText,
  type TelegramOutboxSender,
  type TelegramPoolBridgeModuleConfig,
  type TelegramUpdate,
} from "./telegram-bridge.js";
import type { PoolChatService } from "./service.js";

function createMockPoolChatService(
  handler: (input: Parameters<PoolChatService["submit"]>[0]) => Promise<{
    request: { id: string; status: "completed" | "failed"; result?: { text: string } };
    result: { text: string } | null;
    replayed: boolean;
  }> = async (input) => ({
    request: {
      id: "req-1",
      status: "completed",
      result: { text: `Echo from ${input.body.model}: ${input.body.messages[0]?.content}` },
    },
    result: { text: `Echo from ${input.body.model}: ${input.body.messages[0]?.content}` },
    replayed: false,
  }),
): PoolChatService {
  return {
    capabilities: vi.fn() as unknown as PoolChatService["capabilities"],
    submit: vi.fn(handler) as unknown as PoolChatService["submit"],
    status: vi.fn() as unknown as PoolChatService["status"],
  };
}

describe("Telegram Pool Bridge", () => {
  describe("redactSecret and redaction safety", () => {
    it("redacts bot token and secret from strings and errors", () => {
      const secret = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
      const errorMsg = `HTTP 401: Unauthorized access to https://api.telegram.org/bot${secret}/sendMessage`;
      const redacted = redactSecret(errorMsg, secret);
      expect(redacted).not.toContain(secret);
      expect(redacted).toBe(
        "HTTP 401: Unauthorized access to https://api.telegram.org/bot<redacted>/sendMessage",
      );
    });

    it("redacts bot token when Telegram sender throws or returns an error", async () => {
      const secretToken = "987654:SECRET_TOKEN_XYZ";
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({
        ok: false,
        error: `Failed to call api.telegram.org/bot${secretToken}/sendMessage with 403 Forbidden`,
      }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: secretToken,
            allowedChatId: "1001",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: "1001" },
          text: "Hello",
        },
      };

      const result = await bridge.processUpdate("chatgpt", update);
      expect(result.status).toBe("error");
      expect(result.error).not.toContain(secretToken);
      expect(result.error).toContain("<redacted>");
      expect(bridge.getOutbox()[0]?.error).not.toContain(secretToken);
    });

    it("handles rejected outboxSender promise without unhandled crash and redacts secrets", async () => {
      const secretToken = "987654:CRASH_TOKEN";
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => {
        throw new Error(`Connection timeout reaching https://api.telegram.org/bot${secretToken}/sendMessage`);
      });

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: secretToken,
            allowedChatId: "1001",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 88,
        message: {
          message_id: 11,
          chat: { id: "1001" },
          text: "Will crash outbox",
        },
      };

      const result = await bridge.processUpdate("chatgpt", update);
      expect(result.status).toBe("error");
      expect(result.error).toContain("<redacted>");
      expect(result.error).not.toContain(secretToken);
      expect(result.outboxItem?.status).toBe("failed");
      expect(result.outboxItem?.error).toContain("<redacted>");

      // Subsequent retry of the same update returns deduplicated and does not resubmit to pool
      const retry = await bridge.processUpdate("chatgpt", update);
      expect(retry.status).toBe("deduplicated");
      expect(poolService.submit).toHaveBeenCalledTimes(1);
    });
  });

  describe("splitTelegramMessageText for long answers", () => {
    it("keeps short messages intact", () => {
      const short = "This is a short message.";
      expect(splitTelegramMessageText(short, 4096)).toEqual([short]);
    });

    it("splits messages exceeding 4096 characters into chunks", () => {
      const p1 = "A".repeat(3000);
      const p2 = "B".repeat(2000);
      const full = `${p1}\n\n${p2}`;
      const chunks = splitTelegramMessageText(full, 4096);
      expect(chunks.length).toBe(2);
      expect(chunks[0]?.length).toBeLessThanOrEqual(4096);
      expect(chunks[1]?.length).toBeLessThanOrEqual(4096);
      expect(chunks[0]).toBe(p1);
      expect(chunks[1]).toBe(p2);
    });
  });

  describe("chat allowlist", () => {
    it("refuses messages from non-allowlisted chat ID without invoking pool-chat", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 99 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: "token-1",
            allowedChatId: "allowed-chat-123",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: "attacker-chat-666" },
          text: "Malicious request",
        },
      };

      const result = await bridge.processUpdate("chatgpt", update);
      expect(result.status).toBe("refused");
      expect(result.reason).toBe("chat_not_allowed");
      expect(poolService.submit).not.toHaveBeenCalled();
      expect(mockSender).not.toHaveBeenCalled();
      expect(bridge.getOutbox().length).toBe(0);
    });

    it("refuses messages from non-allowlisted user ID without invoking pool-chat", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 99 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          google: {
            enabled: true,
            moduleId: "mod-google",
            provider: "google",
            model: "gemini-1.5-pro",
            botToken: "token-2",
            allowedChatId: "group-100",
            allowedUserIds: [12345],
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: "group-100" },
          from: { id: 99999 }, // not in allowedUserIds
          text: "Hello from stranger",
        },
      };

      const result = await bridge.processUpdate("google", update);
      expect(result.status).toBe("refused");
      expect(result.reason).toBe("user_not_allowed");
      expect(poolService.submit).not.toHaveBeenCalled();
      expect(mockSender).not.toHaveBeenCalled();
    });

    it("accepts messages from allowlisted chat and user", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 99 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: "token-1",
            allowedChatId: "allowed-chat-123",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: "allowed-chat-123" },
          text: "Authorized request",
        },
      };

      const result = await bridge.processUpdate("chatgpt", update);
      expect(result.status).toBe("delivered");
      expect(poolService.submit).toHaveBeenCalledTimes(1);
      expect(mockSender).toHaveBeenCalledTimes(1);
    });

    it("fails closed when allowedChatId is not configured or empty", async () => {
      const poolService = createMockPoolChatService();
      const mockSender = vi.fn();
      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            allowedChatId: "",
          },
        },
        outboxSender: mockSender,
      });

      const result = await bridge.processUpdate("chatgpt", {
        update_id: 12,
        message: {
          message_id: 1,
          chat: { id: "any-chat" },
          text: "hello",
        },
      });

      expect(result.status).toBe("refused");
      expect(result.reason).toBe("chat_not_allowed");
      expect(poolService.submit).not.toHaveBeenCalled();
      expect(mockSender).not.toHaveBeenCalled();
    });
  });

  describe("update deduplication (дедуп update)", () => {
    it("deduplicates identical update_id without calling pool-chat or sender again", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 101 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: "token-1",
            allowedChatId: "chat-1",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 555,
        message: {
          message_id: 20,
          chat: { id: "chat-1" },
          text: "Original message",
        },
      };

      const first = await bridge.processUpdate("chatgpt", update);
      expect(first.status).toBe("delivered");
      expect(poolService.submit).toHaveBeenCalledTimes(1);
      expect(mockSender).toHaveBeenCalledTimes(1);

      // Re-send same update (e.g. Telegram webhook retry)
      const second = await bridge.processUpdate("chatgpt", update);
      expect(second.status).toBe("deduplicated");
      expect(second.reason).toBe("update_already_processed");
      expect(poolService.submit).toHaveBeenCalledTimes(1); // not called again
      expect(mockSender).toHaveBeenCalledTimes(1); // not sent again
    });

    it("handles concurrent deliveries of same update_id without duplicate poolChat submit", async () => {
      let resolveSubmit: (val: unknown) => void;
      const delayedSubmitPromise = new Promise((resolve) => {
        resolveSubmit = resolve;
      });

      const poolService = createMockPoolChatService(async () => {
        await delayedSubmitPromise;
        return {
          request: { id: "req-1", status: "completed", result: { text: "Concurrent reply" } },
          result: { text: "Concurrent reply" },
          replayed: false,
        };
      });
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 333 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: "token-1",
            allowedChatId: "chat-1",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 777,
        message: {
          message_id: 50,
          chat: { id: "chat-1" },
          text: "Concurrent test",
        },
      };

      // Launch two concurrent processUpdate calls
      const call1 = bridge.processUpdate("chatgpt", update);
      const call2 = bridge.processUpdate("chatgpt", update);

      // Now resolve the underlying pool submission
      resolveSubmit!({});

      const [res1, res2] = await Promise.all([call1, call2]);
      expect(poolService.submit).toHaveBeenCalledTimes(1);
      expect(res1.status).toBe("delivered");
      expect(res2.status).toBe("deduplicated");
    });

    it("does not cache submit error in processedUpdates so retry can succeed", async () => {
      const poolService = createMockPoolChatService();
      poolService.submit
        .mockRejectedValueOnce(new Error("Temporary submit error"))
        .mockResolvedValueOnce({
          request: { id: "req-retry", status: "completed", result: { text: "Success on retry" } },
          result: { text: "Success on retry" },
        } as any);
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 102 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            allowedChatId: "chat-1",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 999,
        message: {
          message_id: 25,
          chat: { id: "chat-1" },
          text: "Retry test",
        },
      };

      const res1 = await bridge.processUpdate("chatgpt", update);
      expect(res1.status).toBe("error");
      expect(res1.error).toContain("Temporary submit error");

      // Retry delivery
      const res2 = await bridge.processUpdate("chatgpt", update);
      expect(res2.status).toBe("delivered");
      expect(poolService.submit).toHaveBeenCalledTimes(2);
      expect(mockSender).toHaveBeenCalledTimes(1);
    });

    it("retries outbox sender on failure without re-calling poolChatService submit", async () => {
      const poolService = createMockPoolChatService();
      let senderAttempts = 0;
      const mockSender: TelegramOutboxSender = vi.fn(async () => {
        senderAttempts++;
        if (senderAttempts === 1) {
          throw new Error("Temporary network error");
        }
        return { ok: true, messageId: 103 };
      });

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            allowedChatId: "chat-1",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 1005,
        message: {
          message_id: 30,
          chat: { id: "chat-1" },
          text: "Test retry",
        },
      };

      const res = await bridge.processUpdate("chatgpt", update);
      expect(res.status).toBe("delivered");
      expect(poolService.submit).toHaveBeenCalledTimes(1);
      expect(mockSender).toHaveBeenCalledTimes(2);
    });

    it("uses update.update_id in idempotencyKey and clientMessageId for durable adapter deduplication", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 444 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: "token-1",
            allowedChatId: "chat-1",
          },
        },
        outboxSender: mockSender,
      });

      const update1: TelegramUpdate = {
        update_id: 9901,
        message: {
          message_id: 1,
          chat: { id: "chat-1" },
          text: "First msg id",
        },
      };

      await bridge.processUpdate("chatgpt", update1);
      const firstCall = vi.mocked(poolService.submit).mock.calls[0][0];
      expect(firstCall.body.clientMessageId).toBe("tg-upd-9901");
      const expectedIdempotencyKey = createHash("sha256")
        .update("tg-bridge:chatgpt:chat-1:update:9901")
        .digest("hex");
      expect(firstCall.idempotencyKey).toBe(expectedIdempotencyKey);
    });
  });

  describe("both pools: ChatGPT and Google AI / Gemini", () => {
    it("dispatches to ChatGPT pool with ChatGPT model and isolated conversation", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 201 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "chatgpt-main",
            provider: "chatgpt",
            model: "balanced",
            botToken: "tg-token-chatgpt",
            allowedChatId: "tg-chat-gpt",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 101,
        message: {
          message_id: 31,
          chat: { id: "tg-chat-gpt" },
          text: "What is 2+2?",
        },
      };

      const result = await bridge.processUpdate("chatgpt", update);
      expect(result.status).toBe("delivered");
      expect(poolService.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          moduleId: "chatgpt-main",
          channel: "telegram",
          subjectId: "tg-chat-gpt",
          body: expect.objectContaining({
            conversationId: "tg:chatgpt:tg-chat-gpt",
            model: "balanced",
          }),
        }),
      );
      expect(mockSender).toHaveBeenCalledWith(
        expect.objectContaining({
          botToken: "tg-token-chatgpt",
          chatId: "tg-chat-gpt",
          replyToMessageId: 31,
        }),
      );
    });

    it("dispatches to Google AI / Gemini pool with Gemini model and isolated conversation", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn(async () => ({ ok: true, messageId: 301 }));

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          google: {
            enabled: true,
            moduleId: "gemini-main",
            provider: "google",
            model: "gemini-1.5-pro",
            botToken: "tg-token-gemini",
            allowedChatId: "tg-chat-gemini",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 102,
        message: {
          message_id: 42,
          chat: { id: "tg-chat-gemini" },
          text: "Explain quantum computing",
        },
      };

      const result = await bridge.processUpdate("google", update);
      expect(result.status).toBe("delivered");
      expect(poolService.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          moduleId: "gemini-main",
          channel: "telegram",
          subjectId: "tg-chat-gemini",
          body: expect.objectContaining({
            conversationId: "tg:google:tg-chat-gemini",
            model: "gemini-1.5-pro",
          }),
        }),
      );
      expect(mockSender).toHaveBeenCalledWith(
        expect.objectContaining({
          botToken: "tg-token-gemini",
          chatId: "tg-chat-gemini",
          replyToMessageId: 42,
        }),
      );
    });
  });

  describe("long responses and outbox", () => {
    it("splits long responses into multiple outbox deliveries", async () => {
      const longResponseText = "X".repeat(5000);
      const poolService = createMockPoolChatService(async () => ({
        request: {
          id: "req-long",
          status: "completed",
          result: { text: longResponseText },
        },
        result: { text: longResponseText },
        replayed: false,
      }));

      let sentCount = 0;
      const mockSender: TelegramOutboxSender = vi.fn(async () => {
        sentCount += 1;
        return { ok: true, messageId: 500 + sentCount };
      });

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: true,
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: "token-1",
            allowedChatId: "chat-long",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 999,
        message: {
          message_id: 88,
          chat: { id: "chat-long" },
          text: "Generate 5000 chars",
        },
      };

      const result = await bridge.processUpdate("chatgpt", update);
      expect(result.status).toBe("delivered");
      expect(result.outboxItem?.parts.length).toBe(2);
      expect(result.outboxItem?.deliveredMessageIds.length).toBe(2);
      expect(mockSender).toHaveBeenCalledTimes(2);
    });
  });

  describe("default disabled (по умолчанию выключен)", () => {
    it("ignores updates when bridge is disabled by default", async () => {
      const poolService = createMockPoolChatService();
      const mockSender: TelegramOutboxSender = vi.fn();

      const bridge = createTelegramPoolBridge({
        poolChatService: poolService,
        modules: {
          chatgpt: {
            enabled: false, // disabled by default
            moduleId: "mod-chatgpt",
            provider: "chatgpt",
            model: "balanced",
            botToken: "token-1",
            allowedChatId: "chat-1",
          },
        },
        outboxSender: mockSender,
      });

      const update: TelegramUpdate = {
        update_id: 123,
        message: {
          message_id: 1,
          chat: { id: "chat-1" },
          text: "Hello",
        },
      };

      const result = await bridge.processUpdate("chatgpt", update);
      expect(result.status).toBe("ignored");
      expect(result.reason).toBe("bridge_disabled");
      expect(poolService.submit).not.toHaveBeenCalled();
      expect(mockSender).not.toHaveBeenCalled();
    });
  });
});
