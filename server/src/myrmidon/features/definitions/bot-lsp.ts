// myrmidon(FEATURES): bot language servers by role.
//
// Health source: none at runtime. The board writes the `lsp` block into each
// bot's profile and cannot see whether the language servers start inside the
// container, so the entry reports `unknown` and shows what it does know — how
// many bots resolve to a language-server mode.

import { BOT_LSP_SETTINGS_KEY, effectiveBotLspSettings, type BotLspSettings } from "@paperclipai/shared";
import { entry, healthOff, healthUnknown, listText } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const botLspFeature: FeatureDefinition = {
  key: "bot-lsp",
  name: "Bot language servers",
  description:
    "Writes the language-server block of each bot's profile by role: limited for coding castes, off for the rest unless a card says otherwise.",
  docs: "docs/myrmidon/guides/bot-lsp.md",
  settings: { path: "/company/settings", panel: "Bot language servers" },

  readConfig(ctx) {
    const stored = ctx.general[BOT_LSP_SETTINGS_KEY];
    const row = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    const source = (key: string) => (key in row ? "settings" : "default") as "settings" | "default";
    const effective = effectiveBotLspSettings(row as BotLspSettings);
    return {
      enabled: effective.codingMode !== "off" || effective.nonCodingMode !== "off",
      entries: [
        entry("Coding roles", listText(effective.codingRoles, "none"), source("codingRoles")),
        entry("Mode for coding roles", effective.codingMode, source("codingMode")),
        entry("Mode for other roles", effective.nonCodingMode, source("nonCodingMode")),
        entry("Idle timeout, s", effective.idleTimeoutSeconds, source("idleTimeoutSeconds")),
        entry("tsserver memory, MB", effective.tsserverMemoryMb, source("tsserverMemoryMb")),
        entry("Excluded roots", listText(effective.excludeRoots, "none"), source("excludeRoots")),
      ],
    };
  },

  async health(ctx) {
    const counts = await ctx.ports.lsp.modeCounts(ctx.general);
    const on = counts.limited + counts.full;
    if (on === 0) return healthOff("no bot resolves to a language-server mode");
    return healthUnknown(
      `${on} bot(s) are configured with a language server (${counts.limited} limited, ${counts.full} full); the board cannot see whether the servers start inside the containers`,
      { effect: { label: "bots with a language-server mode", value: on } },
    );
  },
};
