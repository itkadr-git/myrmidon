import { chatPublications, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { defaultTelegramNotifySettings } from "../telegram-notify/settings.js";
import { resolveTargetConversation } from "../telegram-notify/jobs.js";
import type { BotPartitionNotifyInput } from "./partition.js";

/**
 * Owner notification for the bot-partition critical threshold (myrmidon 1.6.5
 * BOT-DISK-H10) — the "owner telegram cards" channel.
 *
 * Reuses the telegram-notify machinery instead of inventing a new sender: the
 * destination is the configured escalations chat/topic of the part-A settings
 * (the owner-facing channel), the transport is the `chat_publications` outbox
 * the vendor sweep already drains, and the idempotency key deduplicates
 * retries within one day. When the owner has no telegram channel configured
 * the notification is skipped and logged — the attention card still carries
 * the signal.
 */

export interface OwnerTelegramNotifierDeps {
  /** Company ids to notify; the host disk is instance-wide, every company owner gets the card. */
  listCompanyIds(): Promise<string[]>;
  now?: () => Date;
}

/**
 * The notifier the partition runtime calls at the critical crossing. Exported
 * for the wiring in `host-disk/index.ts`.
 */
export function createOwnerTelegramNotifier(
  db: Db,
  deps: OwnerTelegramNotifierDeps,
): (input: BotPartitionNotifyInput) => Promise<void> {
  const now = deps.now ?? (() => new Date());
  return async ({ usage, settings }) => {
    const channel = defaultTelegramNotifySettings().escalations;
    const companyIds = await deps.listCompanyIds();
    for (const companyId of companyIds) {
      // The part-A settings routes are not merged; until they are, the
      // channel comes from the fixed document. An operator with no telegram
      // endpoint configured gets no card — the attention feed row remains.
      const conversation = await resolveTargetConversation(db, {
        companyId,
        chatId: channel.chatId,
        topicId: channel.topicId,
      });
      if (!conversation) {
        logger.info({ companyId }, "bot partition critical: no owner telegram channel, card only");
        continue;
      }
      const text = [
        "🚨 Bot partition is critically full",
        "",
        `- Partition ${usage.mount} is at ${usage.usedPercent.toFixed(1)}% (critical threshold ${settings.partitionCriticalPercent}%).`,
        `- Free: ${(usage.freeBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB of ${(usage.totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB.`,
        `- myr-ws open refuses new copies from ${settings.partitionRefuseOpenPercent}% (pressure level hard, grace 0).`,
        "- Free space on the bot host or raise the quotas; the alert clears below the warn threshold.",
      ].join("\n");
      const at = now().toISOString().slice(0, 10);
      try {
        await db
          .insert(chatPublications)
          .values({
            companyId,
            endpointId: conversation.endpointId,
            conversationId: conversation.conversationId,
            issueId: conversation.issueId,
            idempotencyKey: `host-disk:partition-critical:${companyId}:${usage.mount}:${at}`,
            payload: projectSafeChatPublication({
              classification: "external",
              source: "safe_milestone",
              text,
            }),
            state: "pending",
          })
          .onConflictDoNothing();
        logger.info(
          { companyId, usedPercent: usage.usedPercent, mount: usage.mount },
          "bot partition critical owner notification enqueued",
        );
      } catch (err) {
        logger.error({ err, companyId }, "bot partition critical owner notification failed");
      }
    }
  };
}
