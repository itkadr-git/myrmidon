import { describe, expect, it, vi } from "vitest";
import { defaultTelegramNotifySettings } from "@myrmidon/shared";
import {
  formatUpdateEventMessage,
  notifyOwnerAboutUpdate,
  type UpdateNotifyPorts,
  type UpdateEventPayload,
} from "./update-notify.js";

describe("myrmidon(OPE-8656): update-notify message formatting", () => {
  it("formats canary_started message", () => {
    const text = formatUpdateEventMessage({
      companyId: "c1",
      eventType: "canary_started",
      version: "v1.7.0",
      detail: "1 of 5 bots",
    });
    expect(text).toContain("🐤 Начало канареечного обновления: v1.7.0 (1 of 5 bots)");
  });

  it("formats rollout_succeeded message", () => {
    const text = formatUpdateEventMessage({
      companyId: "c1",
      eventType: "rollout_succeeded",
      version: "v1.7.0",
      commit: "abcdef123456",
    });
    expect(text).toContain("✅ Успешный выкат обновления: v1.7.0 [abcdef1]");
  });

  it("formats rollback_started message", () => {
    const text = formatUpdateEventMessage({
      companyId: "c1",
      eventType: "rollback_started",
      version: "v1.7.0",
      reason: "high error rate",
    });
    expect(text).toContain("⚠️ Начало автоматического отката версии v1.7.0: high error rate");
  });

  it("formats rollback_completed message with reason", () => {
    const text = formatUpdateEventMessage({
      companyId: "c1",
      eventType: "rollback_completed",
      targetVersion: "v1.6.6",
      reason: "canary health check failed",
    });
    expect(text).toContain("🚨 Автооткат завершён на версию v1.6.6. Причина: canary health check failed");
  });

  it("formats waiting_window message", () => {
    const text = formatUpdateEventMessage({
      companyId: "c1",
      eventType: "waiting_window",
      version: "v1.7.0",
      windowStart: "02:00",
      windowEnd: "05:00",
    });
    expect(text).toContain("⏳ Ожидание окна обслуживания для v1.7.0 (окно: 02:00 – 05:00)");
  });
});

describe("myrmidon(OPE-8656): notifyOwnerAboutUpdate lifecycle & settings", () => {
  function makeMockPorts(overrides: Partial<UpdateNotifyPorts> = {}): {
    ports: UpdateNotifyPorts;
    publications: Array<{
      companyId: string;
      endpointId: string;
      conversationId: string;
      issueId: string;
      idempotencyKey: string;
      text: string;
    }>;
  } {
    const publications: Array<any> = [];
    const ports: UpdateNotifyPorts = {
      async readSettings(_companyId) {
        return defaultTelegramNotifySettings();
      },
      async findOwnerDeliveryRecipient(_companyId) {
        return null;
      },
      async resolveDirectConversation(_companyId, _chatId, _topicId) {
        return null;
      },
      async enqueuePublication(input) {
        publications.push(input);
        return { inserted: true };
      },
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      ...overrides,
    };
    return { ports, publications };
  }

  it("sends nothing when telegramNotify.updates.enabled is false (default)", async () => {
    const { ports, publications } = makeMockPorts({
      async readSettings() {
        const s = defaultTelegramNotifySettings();
        expect(s.updates.enabled).toBe(false);
        return s;
      },
    });

    const res = await notifyOwnerAboutUpdate(ports, {
      companyId: "c1",
      eventType: "canary_started",
      version: "v1.7.0",
    });

    expect(res).toEqual({ sent: false, reason: "updates_disabled" });
    expect(publications).toHaveLength(0);
  });

  it("delivers through owner-delivery when active channel exists", async () => {
    const { ports, publications } = makeMockPorts({
      async readSettings() {
        const s = defaultTelegramNotifySettings();
        s.updates.enabled = true;
        s.updates.chatId = "direct-chat-id";
        return s;
      },
      async findOwnerDeliveryRecipient() {
        return {
          conversationId: "conv-owner-1",
          endpointId: "endp-owner-1",
          issueId: "issue-owner-1",
        };
      },
    });

    const res = await notifyOwnerAboutUpdate(ports, {
      companyId: "c1",
      eventType: "rollout_succeeded",
      version: "v1.7.0",
    });

    expect(res).toEqual({ sent: true, channel: "owner_delivery" });
    expect(publications).toHaveLength(1);
    expect(publications[0].conversationId).toBe("conv-owner-1");
    expect(publications[0].endpointId).toBe("endp-owner-1");
    expect(publications[0].text).toContain("✅ Успешный выкат обновления: v1.7.0");
  });

  it("falls back to telegram_direct when no owner-delivery exists", async () => {
    const { ports, publications } = makeMockPorts({
      async readSettings() {
        const s = defaultTelegramNotifySettings();
        s.updates.enabled = true;
        s.updates.chatId = "tg-direct-chat";
        s.updates.topicId = "123";
        return s;
      },
      async findOwnerDeliveryRecipient() {
        return null;
      },
      async resolveDirectConversation(_companyId, chatId, topicId) {
        expect(chatId).toBe("tg-direct-chat");
        expect(topicId).toBe("123");
        return {
          conversationId: "conv-direct-1",
          endpointId: "endp-direct-1",
          issueId: "issue-direct-1",
        };
      },
    });

    const res = await notifyOwnerAboutUpdate(ports, {
      companyId: "c1",
      eventType: "rollback_completed",
      targetVersion: "v1.6.6",
      reason: "health check failed",
    });

    expect(res).toEqual({ sent: true, channel: "telegram_direct" });
    expect(publications).toHaveLength(1);
    expect(publications[0].conversationId).toBe("conv-direct-1");
    expect(publications[0].text).toContain("🚨 Автооткат завершён на версию v1.6.6. Причина: health check failed");
  });

  it("returns no_destination_channel when enabled but no channel exists", async () => {
    const { ports, publications } = makeMockPorts({
      async readSettings() {
        const s = defaultTelegramNotifySettings();
        s.updates.enabled = true;
        return s;
      },
    });

    const res = await notifyOwnerAboutUpdate(ports, {
      companyId: "c1",
      eventType: "waiting_window",
      version: "v1.7.0",
    });

    expect(res).toEqual({ sent: false, reason: "no_destination_channel" });
    expect(publications).toHaveLength(0);
  });
});
