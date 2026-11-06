// server/src/myrmidon/bot-containers/tool-diet.ts
//
// myrmidon(TOOL-DIET-ROLES, OPE-11947): per-role default lists of the tools a bot
// does not send to the model. Every tool schema is paid on every model call, and
// a measured sample (28k requests of 21 bots) showed that tools called less than
// 0.5 times per 100 requests still make up 5.5% of all request characters
// (engineers 6.4%, bbq bots 8.2%).
//
// The compiler (profile-compiler.ts) stays role-agnostic and pure: it only merges
// what it is handed. This module is the one place that decides, from the agent's
// role (caste key, `agents.role`) and its card, WHICH groups of tools a bot keeps
// out of its schema. profile-input.ts calls it, exactly like the language-server
// policy (packages/shared/src/myrmidon-bot-lsp.ts).
//
// Two tiers, by role:
//   developer - roles that write and review code (engineer, reviewer, release):
//               no Hermes memory and no Hindsight tools (owner decision 26.10:
//               developer agents have neither writing nor searching), no web, no
//               browser, no image/media tools.
//   standard  - every other role: only the browser and image/media tools, which
//               it never uses unless its card asks for them.
// A bot with no role gets no role diet at all.
//
// A role default never overrides the card:
//   - a group is kept when the card's own `toolsets` names one of the group's
//     toolsets (the card asked for that surface: `memory`, `web`, `browser`, ...);
//   - `keepTools` in the card re-enables a group (by its key or toolset name) or a
//     single tool by name;
//   - `disabledTools` in the card replaces every default list (instance and role).
// Roles are matched by caste key only, never by an agent's name.

/** Instance switch for the role defaults: `off`, `0`, `false`, `no`, `none` or `-` turn them off. Unset = on. */
export const BOT_ROLE_TOOL_DIET_ENV = "MYRMIDON_BOT_ROLE_TOOL_DIET";

/**
 * Instance list of the roles that get the developer tier, comma-separated caste keys.
 * Unset = {@link DEFAULT_BOT_DEVELOPER_ROLES}; `none` = no role gets the developer tier.
 */
export const BOT_DEVELOPER_ROLES_ENV = "MYRMIDON_BOT_DEVELOPER_ROLES";

/** Roles (caste keys) of the developer tier when the instance names none. */
export const DEFAULT_BOT_DEVELOPER_ROLES: readonly string[] = ["engineer", "reviewer", "release"];

export type BotToolGroupKey = "memory" | "web" | "browser" | "media";

export interface BotToolGroup {
  /** Toolset names a card can list in `toolsets` to ask for the group; the group's own key counts as well. */
  toolsets: readonly string[];
  /** Single tools dropped through `agent.disabled_tools`. */
  tools: readonly string[];
  /** Whole toolsets dropped through `agent.disabled_toolsets`. */
  disabledToolsets: readonly string[];
}

/**
 * The groups. Hermes tool names, from the pinned runtime image's `toolsets.py` / tool registry.
 *
 * `memory` is a TOOLSET gate, not a list of names: the Hindsight provider tools
 * (hindsight_retain / hindsight_recall / hindsight_reflect) are injected after the toolset
 * selection and `agent.disabled_tools` does not reach them, but a provider is withheld
 * together with its system-prompt block when `memory` is in `agent.disabled_toolsets`
 * (agent/memory_manager.py `memory_provider_tools_enabled`). The same gate removes the
 * built-in `memory` tool and the background memory review that fires every few turns
 * only while that tool is present.
 */
export const BOT_TOOL_GROUPS: Readonly<Record<BotToolGroupKey, BotToolGroup>> = {
  memory: { toolsets: ["memory"], tools: [], disabledToolsets: ["memory"] },
  web: { toolsets: ["web"], tools: ["web_search", "web_extract"], disabledToolsets: [] },
  browser: {
    toolsets: ["browser", "browser-use", "browser-cdp"],
    tools: [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_back",
      "browser_press",
      "browser_get_images",
      "browser_vision",
      "browser_console",
      "browser_cdp",
      "browser_dialog",
      "browser_vault_list",
      "browser_vault_unlock",
      "browser_vault_fill",
      "browser_vault_save_login",
      "browser_vault_enter_code",
      "browser_exec",
    ],
    disabledToolsets: [],
  },
  media: {
    toolsets: ["image_gen", "video_gen", "video", "tts"],
    tools: ["image_generate", "video_generate", "video_analyze", "text_to_speech"],
    disabledToolsets: [],
  },
};

/** Groups of the developer tier, in the order their names are written. */
export const BOT_DEVELOPER_TOOL_GROUPS: readonly BotToolGroupKey[] = ["memory", "web", "browser", "media"];

/** Groups of the standard tier (every other role). */
export const BOT_STANDARD_TOOL_GROUPS: readonly BotToolGroupKey[] = ["browser", "media"];

export type BotToolDietTier = "developer" | "standard";

export interface BotToolDietRequest {
  /** The agent's role (caste key, `agents.role`). Blank = no role diet. */
  role: string | null | undefined;
  /** The toolset names the card lists in `toolsets`. */
  cardToolsets: readonly string[];
  /** The card's `keepTools`: group keys, toolset names or single tool names the card keeps. */
  keepTools: readonly string[];
  /** Roles of the developer tier; unset = {@link DEFAULT_BOT_DEVELOPER_ROLES}. */
  developerRoles?: readonly string[];
}

export interface BotToolDiet {
  tier: BotToolDietTier;
  /** For `agent.disabled_tools`. */
  disabledTools: string[];
  /** For `agent.disabled_toolsets`. */
  disabledToolsets: string[];
}

function normalizeKey(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The tier a role belongs to under these developer roles. Case-insensitive. */
export function botToolDietTier(role: string, developerRoles: readonly string[] | undefined): BotToolDietTier {
  const key = normalizeKey(role);
  const roles = developerRoles ?? DEFAULT_BOT_DEVELOPER_ROLES;
  return roles.some((item) => normalizeKey(item) === key) ? "developer" : "standard";
}

/**
 * Role + card -> the tools and toolsets the role defaults keep out of the bot's schema.
 * Undefined when the bot has no role. Deterministic: order follows the group tables above.
 */
export function resolveBotToolDiet(request: BotToolDietRequest): BotToolDiet | undefined {
  const role = normalizeKey(request.role);
  if (!role) return undefined;
  const tier = botToolDietTier(role, request.developerRoles);
  const keptTools = new Set(request.keepTools.map(normalizeKey).filter(Boolean));
  // What the card asked for: its own toolsets and its keepTools entries (a group key or toolset name).
  const asked = new Set([...request.cardToolsets.map(normalizeKey), ...keptTools].filter(Boolean));

  const tools = new Set<string>();
  const toolsets = new Set<string>();
  const groups = tier === "developer" ? BOT_DEVELOPER_TOOL_GROUPS : BOT_STANDARD_TOOL_GROUPS;
  for (const key of groups) {
    const group = BOT_TOOL_GROUPS[key];
    if (asked.has(key) || group.toolsets.some((name) => asked.has(name))) continue;
    for (const tool of group.tools) {
      if (!keptTools.has(tool)) tools.add(tool);
    }
    for (const toolset of group.disabledToolsets) toolsets.add(toolset);
  }
  return { tier, disabledTools: [...tools], disabledToolsets: [...toolsets] };
}

const OFF_TOKENS = new Set(["0", "false", "off", "no", "none", "-"]);

/** MYRMIDON_BOT_ROLE_TOOL_DIET -> whether the role defaults are on. Unset/blank = on; an off token = off. */
export function parseBotRoleToolDiet(raw: string | null): boolean {
  if (raw === null) return true;
  return !OFF_TOKENS.has(raw.trim().toLowerCase());
}

const ROLE_KEY = /^[a-z0-9-]+$/;

/**
 * MYRMIDON_BOT_DEVELOPER_ROLES -> caste keys. Unset/blank -> the default; `none`/`off`/`-` -> [];
 * otherwise the trimmed lowercase unique keys in order, an invalid key dropped. A list with no
 * usable key falls back to the default instead of silently emptying the developer tier.
 */
export function parseBotDeveloperRoles(raw: string | null): string[] {
  if (raw === null) return [...DEFAULT_BOT_DEVELOPER_ROLES];
  const lowered = raw.trim().toLowerCase();
  if (lowered === "none" || lowered === "off" || lowered === "-") return [];
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const item of lowered.split(",")) {
    const key = item.trim();
    if (!key || !ROLE_KEY.test(key) || seen.has(key)) continue;
    seen.add(key);
    roles.push(key);
  }
  return roles.length > 0 ? roles : [...DEFAULT_BOT_DEVELOPER_ROLES];
}
