import type { Db } from "@myrmidon/db";
import { chatConversations, chatEndpoints, chatPublications, companies } from "@myrmidon/db";
import { and, eq, inArray } from "drizzle-orm";
import type { TelegramNotifySettings } from "@myrmidon/shared";
import { readTelegramNotifySettingsDocument } from "../telegram-notify/settings-store.js";
import { resolveTargetConversation } from "../telegram-notify/jobs.js";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { logger } from "../../middleware/logger.js";
// myrmidon(1.7-TG-LOCALE / OPE-12689): the notice prose lives in the bridge
// locale catalogs (update.* keys); the locale type comes with it.
import { t, type BridgeLocale } from "../agent-chat-bridge/locales/index.js";
// myrmidon(1.7-TG-LOCALE / OPE-12689): the instance locale is resolved through
// the connector seam like the rest of the channel code (env force, then the
// instance-wide setting, then English) — a notice has no addressee user.
import { telegramDmMenuLocale } from "../channel-connectors/bridge/locales.js";

export type UpdateEventType =
  | "canary_started"
  | "rollout_succeeded"
  | "rollback_started"
  | "rollback_completed"
  | "waiting_window";

export interface UpdateEventPayload {
  companyId: string;
  eventType: UpdateEventType;
  version?: string | null;
  targetVersion?: string | null;
  commit?: string | null;
  digest?: string | null;
  reason?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  detail?: string | null;
}

export function formatUpdateEventMessage(event: UpdateEventPayload, locale: BridgeLocale): string {
  switch (event.eventType) {
    case "canary_started": {
      const version =
        event.version ??
        event.targetVersion ??
        (event.digest ? event.digest.slice(0, 12) : null) ??
        t(locale, "update.defaultVersion");
      const detail = event.detail ? ` (${event.detail})` : "";
      return t(locale, "update.canary_started", { version, detail });
    }
    case "rollout_succeeded": {
      const version =
        event.version ??
        event.targetVersion ??
        (event.digest ? event.digest.slice(0, 12) : null) ??
        t(locale, "update.defaultVersion");
      const commit = event.commit ? ` [${event.commit.slice(0, 7)}]` : "";
      return t(locale, "update.rollout_succeeded", { version, commit });
    }
    case "rollback_started": {
      const version = event.version ?? (event.digest ? event.digest.slice(0, 12) : null) ?? "";
      return t(locale, "update.rollback_started", {
        version: version ? t(locale, "update.rollbackVersionClause", { version }) : "",
        reason: event.reason ? t(locale, "update.reasonLine", { reason: event.reason }) : "",
      });
    }
    case "rollback_completed": {
      return t(locale, "update.rollback_completed", {
        version: event.targetVersion
          ? t(locale, "update.rollbackTargetClause", { version: event.targetVersion })
          : "",
        reason: event.reason ? t(locale, "update.reasonSentence", { reason: event.reason }) : "",
      });
    }
    case "waiting_window": {
      const version = event.version ?? event.targetVersion ?? t(locale, "update.defaultTarget");
      const window = event.windowStart
        ? t(locale, "update.windowSuffix", {
            window: `${event.windowStart}${event.windowEnd ? ` – ${event.windowEnd}` : ""}`,
          })
        : "";
      return t(locale, "update.waiting_window", { version, window });
    }
  }
}

export interface UpdateNotifyPorts {
  readSettings(companyId: string): Promise<TelegramNotifySettings>;
  findOwnerDeliveryRecipient(
    companyId: string,
  ): Promise<UpdateNotifyDeliveryRecipient | null>;
  resolveDirectConversation(
    companyId: string,
    chatId: string | null,
    topicId: string | number | null,
  ): Promise<UpdateNotifyDeliveryRecipient | null>;
  enqueuePublication(input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    issueId: string;
    idempotencyKey: string;
    text: string;
  }): Promise<{ inserted: boolean }>;
  /** myrmidon(1.7-TG-LOCALE / OPE-12689): the notice language (no addressee
   * user exists — the receiver is the owner dialog or a configured chat, so
   * the locale is the instance-wide one, not a person's preference). */
  resolveLocale(): Promise<BridgeLocale>;
  now(): Date;
}

export interface UpdateNotifyDeliveryRecipient {
  conversationId: string;
  endpointId: string;
  issueId: string;
}

export async function notifyOwnerAboutUpdate(
  ports: UpdateNotifyPorts,
  event: UpdateEventPayload,
): Promise<{
  sent: boolean;
  channel?: "owner_delivery" | "telegram_direct";
  reason?: string;
}> {
  const settings = await ports.readSettings(event.companyId);
  if (!settings.updates.enabled) {
    return { sent: false, reason: "updates_disabled" };
  }

  const locale = await ports.resolveLocale();
  const messageText = formatUpdateEventMessage(event, locale);
  const idempotencyKey = `update-notify:${event.companyId}:${event.eventType}:${event.version ?? ""}:${event.commit ?? ""}:${event.reason ?? ""}:${event.windowStart ?? ""}:${ports
    .now()
    .toISOString()
    .slice(0, 13)}`;

  // 1. Try owner-delivery / active channel if available
  const ownerRecipient = await ports.findOwnerDeliveryRecipient(event.companyId);
  if (ownerRecipient) {
    await ports.enqueuePublication({
      companyId: event.companyId,
      endpointId: ownerRecipient.endpointId,
      conversationId: ownerRecipient.conversationId,
      issueId: ownerRecipient.issueId,
      idempotencyKey,
      text: messageText,
    });
    return { sent: true, channel: "owner_delivery" };
  }

  // 2. Otherwise fall back to direct Telegram target
  const directRecipient = await ports.resolveDirectConversation(
    event.companyId,
    settings.updates.chatId,
    settings.updates.topicId,
  );
  if (directRecipient) {
    await ports.enqueuePublication({
      companyId: event.companyId,
      endpointId: directRecipient.endpointId,
      conversationId: directRecipient.conversationId,
      issueId: directRecipient.issueId,
      idempotencyKey,
      text: messageText,
    });
    return { sent: true, channel: "telegram_direct" };
  }

  return { sent: false, reason: "no_destination_channel" };
}

export async function findActiveOwnerDeliveryConversation(
  db: Db,
  companyId: string,
): Promise<UpdateNotifyDeliveryRecipient | null> {
  const rows = await db
    .select({
      conversationId: chatConversations.id,
      endpointId: chatConversations.endpointId,
      issueId: chatConversations.issueId,
    })
    .from(chatConversations)
    .innerJoin(chatEndpoints, eq(chatConversations.endpointId, chatEndpoints.id))
    .where(
      and(
        eq(chatConversations.companyId, companyId),
        eq(chatConversations.isDirectMessage, true),
        inArray(chatConversations.state, ["active", "waiting"]),
        eq(chatEndpoints.provider, "telegram"),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    )
    .limit(1);

  if (rows.length > 0 && rows[0].issueId) {
    return {
      conversationId: rows[0].conversationId,
      endpointId: rows[0].endpointId,
      issueId: rows[0].issueId,
    };
  }
  return null;
}

export function createDbUpdateNotifyPorts(db: Db): UpdateNotifyPorts {
  return {
    // myrmidon(1.7-TG-LOCALE / OPE-12689): the instance-wide locale (env
    // force, then the instance setting, then English) — same resolution the
    // Telegram command menu uses; read per notice, so a language change takes
    // effect without a restart.
    async resolveLocale() {
      return telegramDmMenuLocale(db);
    },
    async readSettings(companyId: string) {
      const doc = await readTelegramNotifySettingsDocument(db, companyId);
      return doc.settings;
    },
    async findOwnerDeliveryRecipient(companyId: string) {
      return findActiveOwnerDeliveryConversation(db, companyId);
    },
    async resolveDirectConversation(
      companyId: string,
      chatId: string | null,
      topicId: string | number | null,
    ) {
      return resolveTargetConversation(db, {
        companyId,
        chatId,
        topicId,
      });
    },
    async enqueuePublication(input) {
      const rows = await db
        .insert(chatPublications)
        .values({
          companyId: input.companyId,
          endpointId: input.endpointId,
          conversationId: input.conversationId,
          issueId: input.issueId,
          idempotencyKey: input.idempotencyKey,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "safe_milestone",
            text: input.text,
          }),
          state: "pending",
        })
        .onConflictDoNothing()
        .returning({ id: chatPublications.id });
      return { inserted: rows.length > 0 };
    },
    now: () => new Date(),
  };
}

export function createUpdateNotifier(db: Db) {
  const ports = createDbUpdateNotifyPorts(db);
  return async (event: UpdateEventPayload): Promise<{ sent: boolean; reason?: string }> => {
    try {
      if (event.companyId && event.companyId.trim() !== "") {
        return await notifyOwnerAboutUpdate(ports, event);
      }
      const rows = await db.select({ id: companies.id }).from(companies);
      let anySent = false;
      for (const row of rows) {
        const res = await notifyOwnerAboutUpdate(ports, { ...event, companyId: row.id });
        if (res.sent) anySent = true;
      }
      return { sent: anySent };
    } catch (err) {
      logger.error({ err, event }, "failed to deliver update lifecycle notification");
      return { sent: false, reason: "error" };
    }
  };
}
