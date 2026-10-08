// myrmidon(GOOGLE-AI-CONNECT-UI): the owner-facing notify port for the sweep.
//
// Production sends the stale question through the board's own Telegram
// channel: the same outbox path the notify jobs use (resolveTargetConversation
// + chatPublications), so it rides the existing endpoint, formatting and
// dedup — no new bot wiring. The destination chat is the first chat the owner
// already configured for Telegram notify (digest, errors or escalations);
// without one, the message is not sent and the UI status stays the only
// signal. The idempotency key is per company per UTC day, so a long-stale
// connection re-asks the owner once a day, never in a burst.

import type { Db } from "@paperclipai/db";
import { chatPublications } from "@paperclipai/db";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { resolveTargetConversation } from "../telegram-notify/jobs.js";
import { readTelegramNotifySettingsDocument } from "../telegram-notify/settings-store.js";

export function googleAiOwnerNotifier(db: Db): (companyId: string, text: string) => Promise<void> {
  return async (companyId, text) => {
    const state = await readTelegramNotifySettingsDocument(db, companyId);
    const settings = state.settings;
    const channels = [settings.digest, settings.errors, settings.escalations];
    for (const channel of channels) {
      const chatId = typeof channel.chatId === "string" ? channel.chatId : null;
      if (!chatId || chatId.trim() === "") continue;
      // The settings topic id is a string; the resolver wants a forum-topic number.
      const rawTopic = typeof channel.topicId === "string" ? channel.topicId : null;
      const topicId = rawTopic && /^\d+$/.test(rawTopic) ? Number(rawTopic) : null;
      const conversation = await resolveTargetConversation(db, {
        companyId,
        chatId,
        topicId,
      });
      if (!conversation) continue;
      const today = new Date().toISOString().slice(0, 10);
      await db
        .insert(chatPublications)
        .values({
          companyId,
          endpointId: conversation.endpointId,
          conversationId: conversation.conversationId,
          issueId: conversation.issueId,
          idempotencyKey: `google-ai-connector:stale:${companyId}:${today}`,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "safe_milestone",
            text,
          }),
          state: "pending",
        })
        .onConflictDoNothing();
      return;
    }
  };
}
