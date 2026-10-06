// myrmidon(FEATURES): the editable "working on it" status message in a bridged
// Telegram DM.
//
// Health source: the delivery rows of the status message in chat_publications
// (state per row, last redacted error). It only applies to a bridged DM, so
// the status switch without the bridge list is a misconfiguration.

import {
  TELEGRAM_DM_CONVERSATIONS_ENV,
  telegramDmConversationsConfigured,
} from "../../agent-chat-bridge/settings.js";
import {
  TELEGRAM_DM_STATUS_ENV,
  TELEGRAM_SPLIT_MAX_PARTS_ENV,
  telegramDmStatusEnabled,
  telegramSplitMaxParts,
} from "../../telegram-dm-status-settings.js";
import { entry, envIsSet, healthOff, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const TELEGRAM_DM_STATUS_FEATURE_KEY = "telegram-dm-status";

export const telegramDmStatusFeature: FeatureDefinition = {
  key: TELEGRAM_DM_STATUS_FEATURE_KEY,
  name: "Telegram DM status and progress",
  description:
    "A bridged Telegram DM gets one status message per run that later milestones edit in place; long answers can be split into inline parts.",
  docs: "docs/myrmidon/guides/telegram-dm-status.md",
  // Environment-only settings: no panel.

  readConfig(ctx) {
    const enabled = telegramDmStatusEnabled(ctx.env);
    const bridged = telegramDmConversationsConfigured(ctx.env);
    const problems: string[] = [];
    if (enabled && !bridged) {
      problems.push(
        `${TELEGRAM_DM_CONVERSATIONS_ENV} is not set: the status message only applies to a bridged DM, so no chat will ever get it`,
      );
    }
    return {
      enabled,
      problems,
      entries: [
        entry("DM status message", enabled ? "on" : "off", envIsSet(ctx.env, TELEGRAM_DM_STATUS_ENV) ? "env" : "default", TELEGRAM_DM_STATUS_ENV),
        entry(
          "Bridged DM conversations",
          bridged ? "set" : null,
          bridged ? "env" : "default",
          TELEGRAM_DM_CONVERSATIONS_ENV,
        ),
        entry(
          "Inline split, max parts",
          telegramSplitMaxParts(ctx.env),
          envIsSet(ctx.env, TELEGRAM_SPLIT_MAX_PARTS_ENV) ? "env" : "default",
          TELEGRAM_SPLIT_MAX_PARTS_ENV,
        ),
      ],
    };
  },

  async health(ctx, config) {
    if (!config.enabled) return healthOff("the DM status switch is off");
    if (config.problems?.length) return makeHealth("misconfigured", config.problems[0]!);
    const stats = await ctx.ports.chatStatus.stats(ctx.since);
    const base = {
      lastSuccessAt: iso(stats.lastDeliveredAt),
      errors24h: stats.failed,
      lastError: stats.lastError ? { at: iso(stats.lastError.at), message: stats.lastError.message } : null,
      effect: { label: "status messages delivered in 24 h", value: stats.delivered },
    };
    const lastErrorAt = stats.lastError?.at ?? null;
    const failingNow =
      stats.failed > 0 &&
      (stats.delivered === 0 || (lastErrorAt !== null && (!stats.lastDeliveredAt || lastErrorAt > stats.lastDeliveredAt)));
    if (failingNow) {
      return makeHealth(
        "failing",
        `${stats.failed} status message(s) failed to deliver in 24 h and none was delivered after the last failure`,
        base,
      );
    }
    if (stats.delivered > 0) {
      return makeHealth("working", `${stats.delivered} status message(s) delivered in 24 h`, base);
    }
    return makeHealth(
      "unknown",
      "unknown — no status message was sent in 24 h (no bridged-DM run, or the feature does not work)",
      base,
    );
  },
};
