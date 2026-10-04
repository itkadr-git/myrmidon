// myrmidon(BOT-LSP-DEFAULTS): labels for the language-server modes, shared by
// the settings panel and the agent card.
import type { BotLspMode } from "@paperclipai/shared";

export const BOT_LSP_MODE_LABELS: Record<BotLspMode, string> = {
  off: "Off",
  limited: "Limited",
  full: "Full (runtime defaults)",
};

export const BOT_LSP_MODE_HINTS: Record<BotLspMode, string> = {
  off: "No language servers: no diagnostics after edits, no memory cost.",
  limited:
    "One TypeScript server per worktree (no separate syntax server), no automatic typings download, a heap cap and a short idle timeout.",
  full: "The runtime's own defaults: a syntax server next to each TypeScript server and a 10-minute idle timeout.",
};
