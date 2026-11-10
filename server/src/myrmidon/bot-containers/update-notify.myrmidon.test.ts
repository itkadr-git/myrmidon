import { describe, expect, it } from "vitest";
import { defaultTelegramNotifySettings } from "@myrmidon/shared";
import {
  formatUpdateEventMessage,
  notifyOwnerAboutUpdate,
  type UpdateNotifyPorts,
  type UpdateEventPayload,
} from "./update-notify.js";
import type { BridgeLocale } from "../agent-chat-bridge/locales/index.js";

describe("myrmidon(OPE-8656): update-notify message formatting", () => {
  it("formats canary_started message (ru, byte-identical to pre-localization)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "canary_started",
        version: "v1.7.0",
        detail: "1 of 5 bots",
      },
      "ru",
    );
    expect(text).toBe("🐤 Начало канареечного обновления: v1.7.0 (1 of 5 bots)");
  });

  it("formats rollout_succeeded message (ru)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "rollout_succeeded",
        version: "v1.7.0",
        commit: "abcdef123456",
      },
      "ru",
    );
    expect(text).toBe("✅ Успешный выкат обновления: v1.7.0 [abcdef1]");
  });

  it("formats rollback_started message (ru)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "rollback_started",
        version: "v1.7.0",
        reason: "high error rate",
      },
      "ru",
    );
    expect(text).toBe("⚠️ Начало автоматического отката версии v1.7.0: high error rate");
  });

  it("formats rollback_completed message with reason (ru)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "rollback_completed",
        targetVersion: "v1.6.6",
        reason: "canary health check failed",
      },
      "ru",
    );
    expect(text).toBe("🚨 Автооткат завершён на версию v1.6.6. Причина: canary health check failed");
  });

  it("formats waiting_window message (ru)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "waiting_window",
        version: "v1.7.0",
        windowStart: "02:00",
        windowEnd: "05:00",
      },
      "ru",
    );
    expect(text).toBe("⏳ Ожидание окна обслуживания для v1.7.0 (окно: 02:00 – 05:00)");
  });

  // myrmidon(1.7-TG-LOCALE / OPE-12689): the same payloads must render in
  // English for an en/unset instance, with the same substitutions and no
  // Cyrillic leakage.
  it("formats canary_started message (en)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "canary_started",
        version: "v1.7.0",
        detail: "1 of 5 bots",
      },
      "en",
    );
    expect(text).toBe("🐤 Canary update starting: v1.7.0 (1 of 5 bots)");
  });

  it("formats rollout_succeeded message (en)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "rollout_succeeded",
        version: "v1.7.0",
        commit: "abcdef123456",
      },
      "en",
    );
    expect(text).toBe("✅ Update rollout succeeded: v1.7.0 [abcdef1]");
  });

  it("formats rollback_started message (en)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "rollback_started",
        version: "v1.7.0",
        reason: "high error rate",
      },
      "en",
    );
    expect(text).toBe("⚠️ Automatic rollback starting for version v1.7.0: high error rate");
  });

  it("formats rollback_completed message with reason (en)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "rollback_completed",
        targetVersion: "v1.6.6",
        reason: "canary health check failed",
      },
      "en",
    );
    expect(text).toBe("🚨 Automatic rollback completed to version v1.6.6. Reason: canary health check failed");
  });

  it("formats waiting_window message (en)", () => {
    const text = formatUpdateEventMessage(
      {
        companyId: "c1",
        eventType: "waiting_window",
        version: "v1.7.0",
        windowStart: "02:00",
        windowEnd: "05:00",
      },
      "en",
    );
    expect(text).toBe("⏳ Waiting for the maintenance window for v1.7.0 (window: 02:00 – 05:00)");
  });
});

describe("myrmidon(OPE-8656): notifyOwnerAboutUpdate lifecycle & settings", () => {
  function makeMockPorts(
    overrides: Partial<UpdateNotifyPorts> = {},
    mockLocale: BridgeLocale = "ru",
  ): {
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
      async resolveLocale(): Promise<BridgeLocale> {
        return mockLocale;
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

  // myrmidon(1.7-TG-LOCALE / OPE-12689): an en instance gets the same
  // lifecycle behavior with the English text; the idempotency key must not
  // depend on the locale, so the same event dedupes across a language switch.
  it("delivers the en text and keeps the idempotency key locale-independent", async () => {
    const enPorts = makeMockPorts(
      {
        async readSettings() {
          const s = defaultTelegramNotifySettings();
          s.updates.enabled = true;
          return s;
        },
        async findOwnerDeliveryRecipient() {
          return {
            conversationId: "conv-owner-en",
            endpointId: "endp-owner-en",
            issueId: "issue-owner-en",
          };
        },
      },
      "en",
    );
    const enRes = await notifyOwnerAboutUpdate(enPorts.ports, {
      companyId: "c1",
      eventType: "rollback_started",
      version: "v1.7.0",
      reason: "high error rate",
    });
    expect(enRes).toEqual({ sent: true, channel: "owner_delivery" });
    expect(enPorts.publications).toHaveLength(1);
    expect(enPorts.publications[0].text).toBe(
      "⚠️ Automatic rollback starting for version v1.7.0: high error rate",
    );
    expect(enPorts.publications[0].text).not.toMatch(/[а-яёА-ЯЁ]/);

    const ruPorts = makeMockPorts(
      {
        async readSettings() {
          const s = defaultTelegramNotifySettings();
          s.updates.enabled = true;
          return s;
        },
        async findOwnerDeliveryRecipient() {
          return {
            conversationId: "conv-owner-ru",
            endpointId: "endp-owner-ru",
            issueId: "issue-owner-ru",
          };
        },
      },
      "ru",
    );
    const ruRes = await notifyOwnerAboutUpdate(ruPorts.ports, {
      companyId: "c1",
      eventType: "rollback_started",
      version: "v1.7.0",
      reason: "high error rate",
    });
    expect(ruRes).toEqual({ sent: true, channel: "owner_delivery" });
    expect(ruPorts.publications[0].text).toBe(
      "⚠️ Начало автоматического отката версии v1.7.0: high error rate",
    );
    expect(ruPorts.publications[0].idempotencyKey).toBe(
      enPorts.publications[0].idempotencyKey,
    );
  });
});
