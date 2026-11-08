// myrmidon(1.6.5 OPE-6318 part A): how /agents groups the company's agents,
// which cards count as live addressees, and how a status reads in a line.
//
// Group source, in order of precedence:
//   1. `agents.metadata.telegramGroup` — a free-text group title the board
//      editor writes (part D of the same epic). It is operator data: the
//      title is rendered as stored, never translated.
//   2. The direction the agent name carries: the first dash-separated
//      segment decides — `adm*` (adm, adm2-cli, adm-dev-eng-*) → the
//      Myrmidon infrastructure domain, `bbq*` → bbq, `work*` → work,
//      anything else (dispatch, qa17, life, Wiki Maintainer) → Other. The
//      titles of these four built-in groups live in the locale catalogs.
//
// Live-card rule (read off the live fleet on 2026-10-08, 83 agents):
//   - statuses `terminated` and `pending_approval` are never listed;
//   - `paused` is hidden by default and can be listed on request
//     (`includePaused`) — a paused card still exists, so /agents counts the
//     hidden ones in the group header instead of dropping them silently;
//   - an agent named `*-retired` is an archived copy (`bbq-editor-retired`);
//   - a card carrying `metadata.pluginManagedAgent` or
//     `metadata.paperclipManagedResource` is a service agent a plugin owns
//     (the fleet's "Wiki Maintainer"), not a chat addressee: the plugin host
//     writes both markers together, see server/src/services/plugin-managed-agents.ts.
//
// Everything here is read-only — no function in this module writes to the
// agents table.

import { t, type BridgeLocale, type BridgeTextKey } from "./locales/index.js";

/** Built-in group ids; the visible titles come from the locale catalogs. */
export type AgentGroupId = "infra" | "bbq" | "work" | "other";

/** Catalog key of every built-in group's title. */
const AGENT_GROUP_TITLE_KEYS: Record<AgentGroupId, BridgeTextKey> = {
  infra: "agents.group.infra",
  bbq: "agents.group.bbq",
  work: "agents.group.work",
  other: "agents.group.other",
};

/**
 * The group a card belongs to: the built-in one derived from the name, plus
 * the card's own title when `metadata.telegramGroup` carries one (data, so
 * two cards can share a built-in id and still be listed apart).
 */
export interface AgentGroupRef {
  id: AgentGroupId;
  /** The card's own group title, or null for a built-in group. */
  title: string | null;
}

/** The `telegramGroup` title off one card's metadata, trimmed; null if absent. */
export function readTelegramGroup(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).telegramGroup;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The built-in group of an agent by name: the first dash-separated segment
 * carries the direction (`adm-dev-eng-15` → adm, `bbq-editor` → bbq).
 */
export function agentGroupFromName(name: string): AgentGroupId {
  const prefix = name.trim().toLowerCase().split("-")[0] ?? "";
  if (prefix.startsWith("adm")) return "infra";
  if (prefix.startsWith("bbq")) return "bbq";
  if (prefix.startsWith("work")) return "work";
  return "other";
}

/** The group of one card: its own metadata title wins over the name prefix. */
export function resolveAgentGroup(name: string, metadata: unknown): AgentGroupRef {
  return { id: agentGroupFromName(name), title: readTelegramGroup(metadata) };
}

/** The visible group title: the card's own one, else the catalog's. */
export function agentGroupTitle(locale: BridgeLocale, group: AgentGroupRef): string {
  return group.title ?? t(locale, AGENT_GROUP_TITLE_KEYS[group.id]);
}

/** Statuses that are never listed, whatever the options say. */
export const UNADDRESSABLE_AGENT_STATUSES: readonly string[] = ["terminated", "pending_approval"];

/** The status hidden by default but listable on request. */
export const PAUSED_AGENT_STATUS = "paused";

/** Factory keys: a card without them is an addressable agent, not a service. */
const SERVICE_CARD_METADATA_KEYS: readonly string[] = [
  "pluginManagedAgent",
  "paperclipManagedResource",
];

/** True for an archived copy of an agent (`bbq-editor-retired`). */
export function isRetiredAgentName(name: string): boolean {
  return /-retired$/i.test(name.trim());
}

/** True for a plugin-owned service card (no live card in the chat sense). */
export function isServiceAgentCard(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return SERVICE_CARD_METADATA_KEYS.some((key) => record[key] !== undefined && record[key] !== null);
}

/** True when the status alone keeps a card out of the list. */
export function isHiddenAgentStatus(
  status: string,
  options: { includePaused?: boolean } = {},
): boolean {
  if (UNADDRESSABLE_AGENT_STATUSES.includes(status)) return true;
  if (status === PAUSED_AGENT_STATUS) return options.includePaused !== true;
  return false;
}

/**
 * A card that /agents must not list: a service card, an archived copy or a
 * status the caller asked to hide. `includePaused` lists paused cards and
 * keeps only the terminal statuses and the service cards out.
 */
export function isHiddenAgentCard(
  card: { status: string; retired: boolean; service: boolean },
  options: { includePaused?: boolean } = {},
): boolean {
  return card.service || card.retired || isHiddenAgentStatus(card.status, options);
}

/** Catalog keys of the three live statuses; anything else reads as unknown. */
const AGENT_STATUS_KEYS: Record<string, BridgeTextKey> = {
  idle: "agents.status.idle",
  running: "agents.status.running",
  [PAUSED_AGENT_STATUS]: "agents.status.paused",
};

/** The localized status word of a card line. */
export function agentStatusText(locale: BridgeLocale, status: string): string {
  return t(locale, AGENT_STATUS_KEYS[status] ?? "agents.status.unknown");
}