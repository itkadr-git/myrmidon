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
//
// myrmidon(1.6.5 OPE-6318 part A): /agents answers with the company's agents
// grouped by direction, each line carrying the agent's name, its one-line role
// (agents.title) and its live status (agents.status) — no terminated, pending
// approval, paused or service cards, and no fixed cutoff on the list length —
// the Telegram transport splits a long reply itself (chat-channels.ts).
//
import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
} from "../../../services/activity-log.js";
import { addDefaultAliases, readTelegramAliases as readCardAliases } from "../addressing.js";
import {
  agentGroupTitle,
  agentStatusText,
  isHiddenAgentCard,
  isRetiredAgentName,
  isServiceAgentCard,
  PAUSED_AGENT_STATUS,
  resolveAgentGroup,
  type AgentGroupRef,
} from "../grouping.js";
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

/**
 * An agent as /agents and /to see it: enough to address, group and display.
 * `status`, `service` and `retired` are what the live-card filter reads, so
 * the caller can count the cards it hid (a group header names the paused ones).
 */
export interface CompanyAgentCard {
  id: string;
  name: string;
  /** The agent's role in one line (agents.title); null when the card has none. */
  title: string | null;
  /** Live status (agents.status): idle / running / paused / …. */
  status: string;
  /** Direction the card belongs to: `metadata.telegramGroup`, else the name prefix. */
  group: AgentGroupRef;
  aliases: string[];
  /** True for an archived copy, `*-retired` (OPE-6318 part A). */
  retired: boolean;
  /** True for a plugin-owned service card (OPE-6318 part A). */
  service: boolean;
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

/**
 * Every agent of one company as a card, aliases and group resolved — the
 * caller filters (see `isHiddenAgentCard`), so it can also count what it hid.
 *
 * The computed default aliases (part A) are assigned over the *listable* set
 * only — the same set the @-mention resolver works with — so /agents, /to and
 * `@handle` all name the same agent for the same short alias.
 */
export async function loadCompanyAgentCards(
  db: Db,
  companyId: string,
): Promise<CompanyAgentCard[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      title: agents.title,
      status: agents.status,
      metadata: agents.metadata,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .orderBy(asc(agents.name));
  const cards: CompanyAgentCard[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    status: row.status,
    group: resolveAgentGroup(row.name, row.metadata),
    // X9a order: the card's metadata first, then adapter_config.
    aliases: [
      ...new Set([
        ...readCardAliases(row.metadata),
        ...readCardAliases(row.adapterConfig as Record<string, unknown> | null),
      ]),
    ],
    retired: isRetiredAgentName(row.name),
    service: isServiceAgentCard(row.metadata),
  }));
  const listable = cards.filter((card) => !isHiddenAgentCard(card));
  const aliased = addDefaultAliases(listable);
  const byId = new Map(aliased.map((card) => [card.id, card] as const));
  return cards.map((card) => byId.get(card.id) ?? card);
}

/** Agents of one company that a bridged chat may address, ordered by name. */
export async function listCompanyAddressableAgents(
  db: Db,
  companyId: string,
  options: { includePaused?: boolean } = {},
): Promise<CompanyAgentCard[]> {
  const cards = await loadCompanyAgentCards(db, companyId);
  return cards.filter((card) => !isHiddenAgentCard(card, options));
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

/** The role in one line: a card title may carry newlines, a list line may not. */
function oneLineRole(title: string | null): string | null {
  const role = title?.replace(/\s+/g, " ").trim();
  return role ? role : null;
}

/** One line of /agents; `mark` flags the conversation's current addressee. */
function formatAgentLine(card: CompanyAgentCard, mark: boolean, locale: BridgeLocale): string {
  const status = agentStatusText(locale, card.status);
  const aliases = formatAliases(card.aliases, locale);
  const role = oneLineRole(card.title);
  const line = role
    ? t(locale, "agents.line", { name: card.name, role, status, aliases })
    : t(locale, "agents.lineNoRole", { name: card.name, status, aliases });
  return mark ? `${line} — ${t(locale, "agents.currentSuffix")}` : line;
}

/** Running cards first, then by name: a group's live work reads first. */
function byStatusThenName(left: CompanyAgentCard, right: CompanyAgentCard): number {
  const rank = (card: CompanyAgentCard) => (card.status === "running" ? 0 : 1);
  return rank(left) - rank(right) || left.name.localeCompare(right.name);
}

/** The live cards of one company, grouped for display: the shared base of the text list and the buttons. */
export interface CollectedAgentGroups {
  /** Visible group titles, the current addressee's group first, the rest alphabetical. */
  titles: string[];
  /** Members of each group (live cards only), running first, then by name. */
  members: Map<string, CompanyAgentCard[]>;
  /** How many members of each group wait on pause. */
  pausedByGroup: Map<string, number>;
}

/**
 * Groups the listable cards by the visible group title — a card may bring its
 * own group name through `metadata.telegramGroup`, and two such cards share
 * one group — and orders them: the current addressee's own group first (that
 * is what the owner looks for), then alphabetical; inside a group running
 * cards first, then by name. `cards` is every card of the company, hidden ones
 * included, so the paused ones can be counted per group.
 */
export function collectAgentGroups(
  cards: CompanyAgentCard[],
  currentId: string,
  locale: BridgeLocale,
): CollectedAgentGroups {
  const members = new Map<string, CompanyAgentCard[]>();
  for (const card of cards.filter((entry) => !isHiddenAgentCard(entry))) {
    const title = agentGroupTitle(locale, card.group);
    const bucket = members.get(title);
    if (bucket) bucket.push(card);
    else members.set(title, [card]);
  }
  for (const bucket of members.values()) bucket.sort(byStatusThenName);

  // How many members of each group wait on pause, for the group header.
  const pausedByGroup = new Map<string, number>();
  for (const card of cards) {
    if (card.service || card.retired || card.status !== PAUSED_AGENT_STATUS) continue;
    const title = agentGroupTitle(locale, card.group);
    pausedByGroup.set(title, (pausedByGroup.get(title) ?? 0) + 1);
  }

  const titles = [...members.keys()].sort((left, right) => left.localeCompare(right));
  const currentTitle = titles.find((title) =>
    (members.get(title) ?? []).some((card) => card.id === currentId),
  );
  if (currentTitle) {
    titles.splice(titles.indexOf(currentTitle), 1);
    titles.unshift(currentTitle);
  }
  return { titles, members, pausedByGroup };
}

/** One line of /agents for a card, the current addressee marked. Used by the text list and the buttons. */
export function agentListLine(card: CompanyAgentCard, mark: boolean, locale: BridgeLocale): string {
  return formatAgentLine(card, mark, locale);
}

/**
 * Builds the /agents text reply: the company's addressable agents grouped by
 * direction, every line naming the agent, its one-line role and its live
 * status, the chat's current default addressee marked. Never prints agent ids
 * or any internal identifier.
 *
 * A paused card is not listed, but the group it belongs to keeps saying how
 * many of its members wait on pause, so nothing disappears silently. The
 * whole list is one message; the Telegram transport splits it when it is long,
 * which is why the list carries no cutoff any more. (`/agents` itself answers
 * with buttons since part B; this text is `/agents text`.)
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
  const cards = await loadCompanyAgentCards(db, input.companyId);
  if (!cards.some((card) => !isHiddenAgentCard(card))) {
    return t(input.locale, "agents.none");
  }
  const currentId = input.stickyAgentId ?? input.conversationAgentId;
  const { titles, members, pausedByGroup } = collectAgentGroups(cards, currentId, input.locale);

  const lines: string[] = [t(input.locale, "agents.header")];
  for (const title of titles) {
    const paused = pausedByGroup.get(title) ?? 0;
    lines.push("");
    lines.push(
      paused > 0
        ? t(input.locale, "agents.groupHeaderPaused", { group: title, count: paused })
        : t(input.locale, "agents.groupHeader", { group: title }),
    );
    for (const card of members.get(title) ?? []) {
      lines.push(formatAgentLine(card, card.id === currentId, input.locale));
    }
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
 * the chat endpoint's own agent. Never prints agent ids. The alias list
 * carries the computed default alias (part A) as well, so /who and /agents
 * word the same handle for the same agent.
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
  // The card comes from the same loader /agents uses, so /who names the
  // computed default alias too, and it still answers about a card /agents
  // hides — a paused or service agent can be the sticky addressee.
  const cards = await loadCompanyAgentCards(db, input.companyId);
  const agent = cards.find((card) => card.id === targetId);
  if (!agent) {
    return t(input.locale, "who.unavailable");
  }
  const aliases = agent.aliases;
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
