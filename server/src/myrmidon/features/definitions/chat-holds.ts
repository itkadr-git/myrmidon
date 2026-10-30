// myrmidon(FEATURES): chat hold rules — a chat is a conversation, not a work
// ticket: an owner message always wakes the bot and lifts a settled replay hold.
//
// This is a defect fix with no setting. Health source: the activity line the
// lift writes. No line in 24 h cannot tell "nothing needed lifting" from "the
// lift does not work", so that case is reported unknown, never working.

import { CHAT_OWNER_MESSAGE_CONTINUATION } from "../../chat-holds/clear-on-message.js";
import { entry, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const CHAT_HOLDS_FEATURE_KEY = "chat-holds";
const LIFT_ACTION = "issue.execution_recovery_settled";

export const chatHoldsFeature: FeatureDefinition = {
  key: CHAT_HOLDS_FEATURE_KEY,
  name: "Chat hold rules",
  description:
    "Chats are never held: a crashed or stopped turn does not block the conversation, and an owner message always wakes the bot as a fresh turn.",
  docs: "docs/myrmidon/DIVERGENCE.md",
  // No setting and no panel: always on.

  readConfig() {
    return {
      enabled: null,
      entries: [entry("Switch", "always on (a defect fix, no setting)", "default")],
    };
  },

  async health(ctx) {
    const detail = { key: "continuation", value: CHAT_OWNER_MESSAGE_CONTINUATION };
    const [lifts, last] = await Promise.all([
      ctx.ports.activity.count([LIFT_ACTION], ctx.since, detail),
      ctx.ports.activity.latest([LIFT_ACTION], detail),
    ]);
    const base = {
      lastSuccessAt: iso(last),
      effect: { label: "chat holds lifted by an owner message in 24 h", value: lifts },
    };
    if (lifts > 0) {
      return makeHealth("working", `${lifts} chat hold(s) lifted by an owner message in 24 h`, base);
    }
    return makeHealth(
      "unknown",
      "unknown — no chat hold was lifted in 24 h: either nothing needed lifting or the lift does not work",
      base,
    );
  },
};
