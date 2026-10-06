// myrmidon(X9c): /agents, /to and /who — managing which agent of the company
// this bridged Telegram DM addresses, from the chat itself.
//
// The agent card (agents.adapter_config / agents.metadata) carries
// `telegramAliases` (a list of lowercase latin strings, set in part A of
// TG-MULTI-AGENT). This module:
//   - lists the company's addressable agents with their aliases (/agents);
//   - resolves an alias argument to an agent of the same company;
//   - stores the chat's sticky default addressee (/to <alias>) in the
//     conversation issue's existing `assignee_adapter_overrides` JSON column
//     (key `telegramStickyAgentId`), exactly like /model and /think store
//     `adapterConfig` there — no schema migration (CONVENTIONS: state lives
//     in existing JSON columns);
//   - reports the current addressee (/who).
//
// Protection (the X9c contract): these commands run only inside the owner's
// own bridged Telegram conversation — `loadBridgedCommandContext` (X8b)
// already proves the sender is the linked board user that owns the
// conversation (identity links, `principalResolution.userId` + the X8b
// refusal path for unlinked senders) — and only agents of the same company
// can ever be selected: the company scope is part of every DB read here.
//
// myrmidon(1.7-TG-LOCALE): every reply is read by the chat owner in Telegram,
// so the prose renders from the locale catalogs (../locales) in the linked
// board user's language; aliases and agent names are data and stay as stored.

import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
} from "../../../services/activity-log.js";
import { readTelegramAliases as readCardAliases } from "../addressing.js";
import { t, type BridgeLocale } from "../locales/index.js";
import { isRecord } from "./models.js";

/**
 * The sticky addressee's agent id lives here, on the conversation issue's
 * `assignee_adapter_overrides` JSON column, next to /model and /think's
 * `adapterConfig` key (X8c). Unlike `adapterConfig` it is not a per-run
 * override the adapter consumes — it is chat routing state, but the column
 * is already "state this conversation's owner chose for this chat", which
 * is exactly what a sticky addressee is.
 */
export const TELEGRAM_STICKY_AGENT_KEY = "telegramStickyAgentId";

/** Agent cards that should never be listed or addressable in the chat. */
const UNADDRESSABLE_AGENT_STATUSES: readonly string[] = ["terminated", "pending_approval"];

/** Maximum agents listed by /agents (Telegram message size safety). */
export const MAX_LISTED_AGENTS = 60;

/** An agent as /agents and /to see it: enough to address and to display. */
export interface CompanyAgentCard {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * Reads `telegramAliases` off one agent card JSON column value, via the X9a
 * card reader. Tolerates anything else the JSON might hold: only a non-empty
 * array of non-empty strings counts, entries are trimmed and lowercased
 * (aliases are matched case-insensitively), and duplicates are dropped.
 */
export function readTelegramAliases(adapterConfig: Record<string, unknown> | null | undefined): string[] {
  // Thin delegation to the X9a card reader — one canonical normalization.
  return readCardAliases(adapterConfig);
}

/** Agents of one company that a bridged chat may address, ordered by name. */
export async function listCompanyAddressableAgents(
  db: Db,
  companyId: string,
): Promise<CompanyAgentCard[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      metadata: agents.metadata,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .orderBy(asc(agents.name));
  const cards: CompanyAgentCard[] = [];
  for (const row of rows) {
    if (UNADDRESSABLE_AGENT_STATUSES.includes(row.status)) continue;
    // X9a order: the card's metadata first, then adapter_config.
    const aliases = [
      ...new Set([
        ...readCardAliases(row.metadata),
        ...readCardAliases(row.adapterConfig as Record<string, unknown> | null),
      ]),
    ];
    cards.push({ id: row.id, name: row.name, aliases });
  }
  return cards;
}

/**
 * Resolves an alias (or an exact agent id, for completeness of the sticky
 * read path) to an addressable agent of the given company. Case-insensitive
 * on the alias. Returns null when nothing matches.
 */
export async function resolveCompanyAgentByAlias(
  db: Db,
  companyId: string,
  alias: string,
): Promise<CompanyAgentCard | null> {
  const trimmed = alias.trim().toLowerCase();
  if (!trimmed) return null;
  const cards = await listCompanyAddressableAgents(db, companyId);
  const byAlias = cards.find((card) => card.aliases.includes(trimmed));
  if (byAlias) return byAlias;
  return cards.find((card) => card.id === alias.trim()) ?? null;
}

/** The conversation's sticky addressee agent id, or null when unset. */
export function readStickyAgentId(
  assigneeAdapterOverrides: Record<string, unknown> | null,
): string | null {
  if (!isRecord(assigneeAdapterOverrides)) return null;
  const value = assigneeAdapterOverrides[TELEGRAM_STICKY_AGENT_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Sets or clears the conversation's sticky addressee. Merges into the same
 * JSON column /model and /think use, keeping other keys as-is; the
 * `adapterConfig` override (model/effort) is deliberately left untouched —
 * a routing choice must not reset the chat's model session.
 */
export async function applyStickyAgentOverride(
  input: {
    db: Db;
    companyId: string;
    issueId: string;
    boardUserId: string;
    /** The agent id to make sticky, or null to clear. */
    agentId: string | null;
  },
): Promise<{ applied: boolean }> {
  let publication: ActivityPublication | null = null;
  let applied = false;
  await input.db.transaction(async (tx) => {
    const [issue] = await tx
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update");
    if (!issue) return;

    const overrides: Record<string, unknown> = isRecord(issue.assigneeAdapterOverrides)
      ? issue.assigneeAdapterOverrides
      : {};
    const nextOverrides: Record<string, unknown> = { ...overrides };
    if (input.agentId === null) {
      delete nextOverrides[TELEGRAM_STICKY_AGENT_KEY];
    } else {
      nextOverrides[TELEGRAM_STICKY_AGENT_KEY] = input.agentId;
    }

    await tx
      .update(issues)
      .set({
        assigneeAdapterOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.issueId));

    publication = (
      await persistActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.boardUserId,
        action: "issue.updated",
        entityType: "issue",
        entityId: input.issueId,
        issueId: input.issueId,
        details: {
          source: "chat:telegram",
          conversationStickyAgent: { key: TELEGRAM_STICKY_AGENT_KEY, value: input.agentId },
        },
      })
    ).publication;
    applied = true;
  });
  if (publication) publishActivity(publication);
  return { applied };
}

/** Formats the alias list for a reply, the catalog's no-alias mark when empty. */
function formatAliases(aliases: string[], locale: BridgeLocale): string {
  return aliases.length > 0 ? aliases.join(", ") : t(locale, "agents.noAliases");
}

/** One line of /agents; `mark` flags the conversation's current addressee. */
function formatAgentLine(card: CompanyAgentCard, mark: boolean, locale: BridgeLocale): string {
  const line = `• ${card.name} (${formatAliases(card.aliases, locale)})`;
  return mark ? `${line} — ${t(locale, "agents.currentSuffix")}` : line;
}

/**
 * Builds the /agents reply: the company's addressable agents with their
 * aliases, the chat's current default addressee marked. Never prints agent
 * ids or any internal identifier.
 */
export async function buildAgentsReplyText(
  db: Db,
  input: {
    companyId: string;
    conversationAgentId: string;
    stickyAgentId: string | null;
    locale: BridgeLocale;
  },
): Promise<string> {
  const cards = await listCompanyAddressableAgents(db, input.companyId);
  const currentId = input.stickyAgentId ?? input.conversationAgentId;
  if (cards.length === 0) {
    return t(input.locale, "agents.none");
  }
  const lines: string[] = [t(input.locale, "agents.header")];
  for (const card of cards.slice(0, MAX_LISTED_AGENTS)) {
    lines.push(formatAgentLine(card, card.id === currentId, input.locale));
  }
  lines.push("");
  lines.push(t(input.locale, "agents.hint"));
  return lines.join("\n");
}

/**
 * The /to command: with an argument, resolves it to a same-company agent and
 * makes it the chat's sticky addressee; without one, clears the sticky
 * choice. An unknown alias gets the polite list of valid aliases (catalogs).
 */
export async function handleToCommand(
  input: {
    db: Db;
    companyId: string;
    /** chat_endpoints.assigned_agent_id — the default when no sticky target is set. */
    conversationAgentId: string;
    issueId: string;
    boardUserId: string;
    args: string;
    stickyAgentId: string | null;
    locale: BridgeLocale;
  },
): Promise<{ command: "to"; text: string }> {
  const arg = input.args.trim().replace(/^@/, "");
  if (!arg) {
    if (input.stickyAgentId === null) {
      const [agent] = await input.db
        .select({ name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, input.companyId),
            eq(agents.id, input.conversationAgentId),
            ne(agents.status, "terminated"),
          ),
        )
        .limit(1);
      return {
        command: "to",
        text: t(input.locale, "to.unsetLine", {
          agent: agent?.name ?? t(input.locale, "bridge.thisAgent"),
        }),
      };
    }
    const result = await applyStickyAgentOverride({
      db: input.db,
      companyId: input.companyId,
      issueId: input.issueId,
      boardUserId: input.boardUserId,
      agentId: null,
    });
    if (!result.applied) {
      return { command: "to", text: t(input.locale, "chat.notAvailable") };
    }
    return { command: "to", text: t(input.locale, "to.cleared") };
  }

  const card = await resolveCompanyAgentByAlias(input.db, input.companyId, arg);
  if (!card) {
    const cards = await listCompanyAddressableAgents(input.db, input.companyId);
    const valid = cards.flatMap((entry) => entry.aliases);
    const text =
      valid.length > 0
        ? t(input.locale, "to.unknownAlias", { alias: arg, list: valid.join(", ") })
        : t(input.locale, "to.unknownAliasNoAliases");
    return { command: "to", text };
  }

  if (card.id === input.stickyAgentId) {
    return {
      command: "to",
      text: t(input.locale, "to.alreadySet", {
        agent: card.name,
        aliases: formatAliases(card.aliases, input.locale),
      }),
    };
  }
  const result = await applyStickyAgentOverride({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issueId,
    boardUserId: input.boardUserId,
    agentId: card.id,
  });
  if (!result.applied) {
    return { command: "to", text: t(input.locale, "chat.notAvailable") };
  }
  return {
    command: "to",
    text: t(input.locale, "to.set", {
      agent: card.name,
      aliases: formatAliases(card.aliases, input.locale),
    }),
  };
}

/**
 * The /who reply: the current addressee — the sticky one when set, otherwise
 * the chat endpoint's own agent. Never prints agent ids.
 */
export async function buildWhoReplyText(
  db: Db,
  input: {
    companyId: string;
    conversationAgentId: string;
    stickyAgentId: string | null;
    locale: BridgeLocale;
  },
): Promise<string> {
  const targetId = input.stickyAgentId ?? input.conversationAgentId;
  const [agent] = await db
    .select({
      name: agents.name,
      status: agents.status,
      metadata: agents.metadata,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, targetId)))
    .limit(1);
  if (!agent) {
    return t(input.locale, "who.unavailable");
  }
  const aliases = [
    ...new Set([
      ...readCardAliases(agent.metadata),
      ...readCardAliases(agent.adapterConfig as Record<string, unknown> | null),
    ]),
  ];
  const source =
    input.stickyAgentId !== null
      ? t(input.locale, "who.sourceSticky")
      : t(input.locale, "who.sourceDefault");
  return t(input.locale, "who.line", {
    agent: agent.name,
    aliases: formatAliases(aliases, input.locale),
    source,
  });
}
