import { createHash, randomUUID } from "node:crypto";
import type { PoolChatService } from "./service.js";

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
}

export interface TelegramChat {
  id: number | string;
  type?: string;
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramPoolBridgeModuleConfig {
  enabled: boolean;
  moduleId: string;
  moduleKey?: string;
  companyId?: string;
  provider: "chatgpt" | "google";
  model: string;
  botToken?: string | null;
  allowedChatId?: string | number | null;
  allowedUserIds?: Array<string | number>;
  poolEndpoint?: string | null;
}

export interface TelegramOutboxItem {
  id: string;
  moduleKey: string;
  chatId: string | number;
  replyToMessageId?: number;
  text: string;
  parts: string[];
  status: "pending" | "delivered" | "failed";
  attempts: number;
  deliveredMessageIds: number[];
  error?: string;
  createdAt: Date;
  deliveredAt?: Date;
}

export type TelegramOutboxSender = (item: {
  botToken?: string;
  chatId: string | number;
  text: string;
  replyToMessageId?: number;
}) => Promise<{ ok: boolean; messageId?: number; error?: string }>;

export interface TelegramBridgeProcessResult {
  status: "delivered" | "deduplicated" | "refused" | "ignored" | "error";
  reason?: string;
  updateId?: number;
  chatId?: string | number;
  userId?: number;
  outboxItem?: TelegramOutboxItem;
  error?: string;
}

export function redactSecret(text: string, secret?: string | null): string {
  if (!secret || secret.length === 0) return text;
  return text.split(secret).join("<redacted>");
}

export function splitTelegramMessageText(text: string, maxChunkLength = 4096): string[] {
  if (text.length <= maxChunkLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChunkLength) {
    let splitIndex = remaining.lastIndexOf("\n\n", maxChunkLength);
    if (splitIndex < maxChunkLength * 0.3) {
      splitIndex = remaining.lastIndexOf("\n", maxChunkLength);
    }
    if (splitIndex < maxChunkLength * 0.3) {
      splitIndex = remaining.lastIndexOf(" ", maxChunkLength);
    }
    if (splitIndex <= 0) {
      splitIndex = maxChunkLength;
    }
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export interface TelegramPoolBridgeOptions {
  poolChatService: PoolChatService;
  modules: Record<string, TelegramPoolBridgeModuleConfig>;
  outboxSender?: TelegramOutboxSender;
  defaultCompanyId?: string;
}

export function createTelegramPoolBridge(options: TelegramPoolBridgeOptions) {
  const { poolChatService, modules, defaultCompanyId = "default-company" } = options;
  const processedUpdates = new Map<number, TelegramOutboxItem | null>();
  const outbox: TelegramOutboxItem[] = [];

  const defaultSender: TelegramOutboxSender = async ({ botToken, chatId, text, replyToMessageId }) => {
    if (!botToken) {
      return { ok: false, error: "Bot token not configured" };
    }
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_to_message_id: replyToMessageId,
        }),
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => "HTTP error");
        return { ok: false, error: redactSecret(errorText, botToken) };
      }
      const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
      return { ok: true, messageId: data.result?.message_id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactSecret(msg, botToken) };
    }
  };

  const sender = options.outboxSender ?? defaultSender;

  return {
    getModules(): Record<string, TelegramPoolBridgeModuleConfig> {
      return modules;
    },

    getOutbox(): TelegramOutboxItem[] {
      return outbox;
    },

    getProcessedUpdateIds(): number[] {
      return Array.from(processedUpdates.keys());
    },

    clear(): void {
      processedUpdates.clear();
      outbox.length = 0;
    },

    async processUpdate(
      moduleKeyOrId: string,
      update: TelegramUpdate,
      callOptions?: { companyId?: string },
    ): Promise<TelegramBridgeProcessResult> {
      const config = modules[moduleKeyOrId];
      if (!config || !config.enabled) {
        return { status: "ignored", reason: "bridge_disabled", updateId: update.update_id };
      }

      const message = update.message;
      if (!message || typeof message.text !== "string" || message.text.trim().length === 0) {
        return { status: "ignored", reason: "no_text_message", updateId: update.update_id };
      }

      // Allowlist checks: chat ID
      if (
        config.allowedChatId !== undefined &&
        config.allowedChatId !== null &&
        String(config.allowedChatId).trim().length > 0
      ) {
        if (String(message.chat.id) !== String(config.allowedChatId)) {
          return {
            status: "refused",
            reason: "chat_not_allowed",
            updateId: update.update_id,
            chatId: message.chat.id,
          };
        }
      }

      // Allowlist checks: user ID
      if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        const userId = message.from?.id;
        if (userId === undefined || !config.allowedUserIds.map(String).includes(String(userId))) {
          return {
            status: "refused",
            reason: "user_not_allowed",
            updateId: update.update_id,
            userId,
          };
        }
      }

      // Deduplication check
      if (processedUpdates.has(update.update_id)) {
        const existingOutbox = processedUpdates.get(update.update_id) ?? undefined;
        return {
          status: "deduplicated",
          reason: "update_already_processed",
          updateId: update.update_id,
          outboxItem: existingOutbox,
        };
      }

      const companyId = callOptions?.companyId ?? config.companyId ?? defaultCompanyId;
      const conversationId = `tg:${config.provider}:${message.chat.id}`;
      const clientMessageId = `tg-upd-${update.update_id}-msg-${message.message_id}`;
      const idempotencyKey = createHash("sha256")
        .update(`tg-bridge:${config.provider}:${message.chat.id}:${message.message_id}`)
        .digest("hex");

      let requestRow;
      try {
        const submission = await poolChatService.submit({
          companyId,
          moduleId: config.moduleId,
          channel: "telegram",
          subjectId: String(message.chat.id),
          idempotencyKey,
          body: {
            conversationId,
            clientMessageId,
            model: config.model,
            messages: [
              {
                role: "user",
                content: message.text,
              },
            ],
          },
        });
        requestRow = submission;
      } catch (err) {
        let errorMsg = err instanceof Error ? err.message : String(err);
        if (config.botToken) {
          errorMsg = redactSecret(errorMsg, config.botToken);
        }
        return {
          status: "error",
          updateId: update.update_id,
          error: errorMsg,
        };
      }

      const resultText =
        requestRow && typeof requestRow === "object" && "result" in requestRow && requestRow.result
          ? (requestRow.result as { text?: string }).text ?? ""
          : "";

      const parts = splitTelegramMessageText(resultText, 4096);
      const outboxItem: TelegramOutboxItem = {
        id: randomUUID(),
        moduleKey: config.moduleKey ?? moduleKeyOrId,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: resultText,
        parts,
        status: "pending",
        attempts: 0,
        deliveredMessageIds: [],
        createdAt: new Date(),
      };

      outbox.push(outboxItem);

      // Dispatch parts via outbox
      for (const part of parts) {
        outboxItem.attempts += 1;
        const res = await sender({
          botToken: config.botToken ?? undefined,
          chatId: message.chat.id,
          text: part,
          replyToMessageId: message.message_id,
        });

        if (res.ok && res.messageId !== undefined) {
          outboxItem.deliveredMessageIds.push(res.messageId);
        } else if (!res.ok) {
          outboxItem.status = "failed";
          outboxItem.error = redactSecret(res.error ?? "Failed to send message", config.botToken);
          processedUpdates.set(update.update_id, outboxItem);
          return {
            status: "error",
            updateId: update.update_id,
            outboxItem,
            error: outboxItem.error,
          };
        }
      }

      outboxItem.status = "delivered";
      outboxItem.deliveredAt = new Date();
      processedUpdates.set(update.update_id, outboxItem);

      return {
        status: "delivered",
        updateId: update.update_id,
        outboxItem,
      };
    },
  };
}
