// myrmidon(1.6.5 OPE-6318 part B): /agents with inline Telegram buttons.
//
// `/agents` answers with the company's directions as buttons; a direction opens
// its agents (a page of ten, "more" for the rest), an agent opens its own card
// with "write" (the same effect as `/to <alias>`), "model" and "stop".
// `/agents text` stays the plain grouped list for a client without buttons.
//
// How a button works end to end:
//   - the reply carries an `AgentsScreen` (text + buttons). The publication is
//     a `task_control` card (chat-publication-projection.ts, standalone card);
//   - every button is an opaque, random token — a `chat_actions` row of kind
//     `agents_button` that holds what the button does, the publication it
//     belongs to and its expiry. Telegram's callback_data (64 bytes) only ever
//     carries the token, never an agent id;
//   - a click is resolved by the chat-channels action handler, which proves the
//     sender is the owner of the bridged conversation, then calls
//     `runAgentsButtonAction` and stages the next screen as a new message.
//
// Protection: the same as the commands — `loadBridgedCommandContext` proves
// the sender owns this very Telegram conversation, every read is scoped to the
// company, and a token is bound to one conversation and one message.
//
// Every human-readable string comes from the locale catalogs (../locales).

import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, chatActions, chatConversations, chatPublications } from "@paperclipai/db";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";
import {
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "../../../services/chat-interaction-publications.js";
import { projectSafeChatPublication } from "../../../services/chat-publication-projection.js";
import { createGatewayModelCatalogReader } from "../gateway-model-catalog.js";
import { isHiddenAgentCard } from "../grouping.js";
import { resolveBridgeLocale, t, type BridgeLocale } from "../locales/index.js";
import {
  agentListLine,
  collectAgentGroups,
  handleToCommand,
  loadCompanyAgentCards,
  readStickyAgentId,
  type CompanyAgentCard,
} from "./agents.js";
import { loadBridgedCommandContext, type BridgedCommandAgentContext } from "./context.js";
import {
  MODEL_CHOOSER,
  checkChooserAvailability,
  describeEffectiveChatValue,
  formatChatChoiceList,
  readOverrideAdapterConfig,
  sourceLabelFor,
  unavailableChoiceText,
  type ChatModelCatalogReader,
} from "./models.js";
import { stopBridgedChatRuns } from "./stop.js";

/** `chat_actions.kind` of one /agents button. */
export const AGENTS_BUTTON_ACTION_KIND = "agents_button";
/** A button stops working after this long; a stale one gets a soft refusal. */
export const AGENTS_BUTTON_TTL_MS = 10 * 60 * 1_000;
/** Agents per page of a direction. */
export const AGENTS_PAGE_SIZE = 10;
/** Telegram cards carry at most this many actions (chat-publication-projection.ts). */
export const AGENTS_MAX_CARD_BUTTONS = 12;

const TOKEN_PREFIX = "pca:";
const TOKEN_BYTES = 16;

/** What one button does. Ids here are internal; the chat never sees them. */
export type AgentsButtonPayload =
  | { op: "groups" }
  | { op: "group"; group: string; page: number }
  | { op: "agent"; agentId: string }
  | { op: "pick"; agentId: string }
  | { op: "model"; agentId: string }
  | { op: "stop"; agentId: string };

export interface AgentsScreenButton {
  label: string;
  action: AgentsButtonPayload;
  style?: "default" | "primary" | "danger";
}

/** One message of the /agents dialog: a title, a body, and its buttons (maybe none). */
export interface AgentsScreen {
  title: string;
  text: string;
  buttons: AgentsScreenButton[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads a stored button payload back; null for anything this module did not write. */
export function parseAgentsButtonPayload(value: unknown): AgentsButtonPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" && UUID_RE.test(record.agentId) ? record.agentId : null;
  const op = record.op;
  switch (op) {
    case "groups":
      return { op: "groups" };
    case "group":
      return typeof record.group === "string" &&
        record.group.length > 0 &&
        typeof record.page === "number" &&
        Number.isInteger(record.page) &&
        record.page >= 0
        ? { op: "group", group: record.group, page: record.page }
        : null;
    case "agent":
    case "pick":
    case "model":
    case "stop":
      return agentId ? { op, agentId } : null;
    default:
      return null;
  }
}

/** A fresh random token; it is the Telegram callback id and the `chat_actions.provider_action_id`. */
export function createAgentsButtonToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function plainScreen(locale: BridgeLocale, text: string): AgentsScreen {
  return { title: "", text, buttons: [] };
}

function backButton(locale: BridgeLocale): AgentsScreenButton {
  return { label: t(locale, "agents.buttons.back"), action: { op: "groups" } };
}

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / AGENTS_PAGE_SIZE));
}

/** The first screen: the directions, each with its live agent count. */
export function buildGroupsScreen(
  cards: CompanyAgentCard[],
  currentId: string,
  locale: BridgeLocale,
): AgentsScreen {
  if (!cards.some((card) => !isHiddenAgentCard(card))) {
    return plainScreen(locale, t(locale, "agents.none"));
  }
  const { titles, members, pausedByGroup } = collectAgentGroups(cards, currentId, locale);
  const lines = [t(locale, "agents.buttons.groupsIntro"), ""];
  const buttons: AgentsScreenButton[] = [];
  for (const title of titles) {
    const count = members.get(title)?.length ?? 0;
    const paused = pausedByGroup.get(title) ?? 0;
    lines.push(
      paused > 0
        ? t(locale, "agents.buttons.groupLinePaused", { group: title, count, paused })
        : t(locale, "agents.buttons.groupLine", { group: title, count }),
    );
    if (buttons.length < AGENTS_MAX_CARD_BUTTONS) {
      buttons.push({
        label: t(locale, "agents.buttons.groupButton", { group: title, count }),
        action: { op: "group", group: title, page: 0 },
      });
    }
  }
  if (titles.length > AGENTS_MAX_CARD_BUTTONS) {
    lines.push("", t(locale, "agents.buttons.moreGroups"));
  }
  return { title: t(locale, "agents.buttons.groupsTitle"), text: lines.join("\n"), buttons };
}

/** A direction's page: its agents as lines and as buttons; null when the direction is gone. */
export function buildGroupScreen(
  cards: CompanyAgentCard[],
  currentId: string,
  locale: BridgeLocale,
  group: string,
  page: number,
): AgentsScreen | null {
  const { members } = collectAgentGroups(cards, currentId, locale);
  const all = members.get(group);
  if (!all || all.length === 0) return null;
  const pages = pageCount(all.length);
  const index = page < pages ? page : 0;
  const slice = all.slice(index * AGENTS_PAGE_SIZE, (index + 1) * AGENTS_PAGE_SIZE);
  const lines = slice.map((card) => agentListLine(card, card.id === currentId, locale));
  if (pages > 1) {
    lines.push("", t(locale, "agents.buttons.page", { page: index + 1, pages }));
  }
  const buttons: AgentsScreenButton[] = slice.map((card) => ({
    label: card.id === currentId ? `✓ ${card.name}` : card.name,
    action: { op: "agent", agentId: card.id },
  }));
  if (pages > 1) {
    buttons.push({
      label: t(locale, "agents.buttons.more"),
      action: { op: "group", group, page: (index + 1) % pages },
    });
  }
  buttons.push(backButton(locale));
  return { title: group, text: lines.join("\n"), buttons };
}

/** One agent's card with its actions; null when the agent is not a live card any more. */
export function buildAgentScreen(
  cards: CompanyAgentCard[],
  currentId: string,
  locale: BridgeLocale,
  agentId: string,
): AgentsScreen | null {
  const card = cards.find((entry) => entry.id === agentId);
  if (!card || isHiddenAgentCard(card)) return null;
  const { titles, members } = collectAgentGroups(cards, currentId, locale);
  const groupTitle = titles.find((title) => (members.get(title) ?? []).some((entry) => entry.id === card.id));
  const position = groupTitle ? (members.get(groupTitle) ?? []).findIndex((entry) => entry.id === card.id) : 0;
  const buttons: AgentsScreenButton[] = [
    { label: t(locale, "agents.buttons.write"), action: { op: "pick", agentId }, style: "primary" },
    { label: t(locale, "agents.buttons.model"), action: { op: "model", agentId } },
    { label: t(locale, "agents.buttons.stop"), action: { op: "stop", agentId }, style: "danger" },
  ];
  if (groupTitle) {
    buttons.push({
      label: t(locale, "agents.buttons.backToGroup", { group: groupTitle }),
      action: { op: "group", group: groupTitle, page: Math.floor(Math.max(0, position) / AGENTS_PAGE_SIZE) },
    });
  }
  return {
    title: t(locale, "agents.buttons.agentTitle", { name: card.name }),
    text: agentListLine(card, card.id === currentId, locale),
    buttons,
  };
}

/** The /agents reply: the directions as buttons. */
export async function buildAgentsGroupsReply(
  db: Db,
  input: {
    companyId: string;
    conversationAgentId: string;
    stickyAgentId: string | null;
    locale: BridgeLocale;
  },
): Promise<AgentsScreen> {
  const cards = await loadCompanyAgentCards(db, input.companyId);
  return buildGroupsScreen(cards, input.stickyAgentId ?? input.conversationAgentId, input.locale);
}

/** Title and body as one plain text, for the clients that cannot show a card. */
export function agentsScreenPlainText(screen: AgentsScreen): string {
  return screen.title ? `${screen.title}\n\n${screen.text}` : screen.text;
}

/** What the model button shows: the model this chat uses for the agent and the choices it has. */
async function buildAgentModelText(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    overrides: Record<string, unknown> | null;
    locale: BridgeLocale;
    readGatewayModelCatalog?: ChatModelCatalogReader | null;
  },
): Promise<string | null> {
  const [row] = await db
    .select({
      id: agents.id,
      name: agents.name,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  if (!row) return null;
  const agent: BridgedCommandAgentContext = {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    adapterConfig: (row.adapterConfig as Record<string, unknown> | null) ?? {},
  };
  const reader =
    input.readGatewayModelCatalog ??
    createGatewayModelCatalogReader({
      db,
      companyId: input.companyId,
      agentId: agent.id,
      agentSlug: agent.name,
    });
  const availability = await checkChooserAvailability(MODEL_CHOOSER, agent, reader);
  if (!availability.available) {
    return unavailableChoiceText(
      MODEL_CHOOSER,
      agent,
      input.locale,
      availability.reasonKey ?? "chooser.reason.unsupportedAdapter",
    );
  }
  const effective = describeEffectiveChatValue(
    readOverrideAdapterConfig(input.overrides),
    agent.adapterConfig,
    MODEL_CHOOSER.adapterConfigKey,
  );
  const sourceText = sourceLabelFor(effective.source, input.locale);
  return [
    t(input.locale, "chooser.effective", {
      label: t(input.locale, MODEL_CHOOSER.statusLabelKey),
      value: effective.value ?? sourceText,
      source: sourceText,
    }),
    t(input.locale, "chooser.availableHeader"),
    formatChatChoiceList(availability.candidates),
    ...(availability.wholeCatalog ? [t(input.locale, "chooser.catalogWhole")] : []),
    t(input.locale, "agents.buttons.modelNote"),
  ].join("\n");
}

export interface AgentsButtonActionInput {
  db: Db;
  companyId: string;
  /** chat_endpoints.assigned_agent_id — the agent of the bridged conversation. */
  conversationAgentId: string;
  conversationIssueId: string;
  /** The linked board user who clicked. */
  boardUserId: string;
  action: AgentsButtonPayload;
  cancelRun: (
    runId: string,
    reason: string,
    options: { errorCode?: string; resultJson?: Record<string, unknown> },
  ) => Promise<unknown>;
  readGatewayModelCatalog?: ChatModelCatalogReader | null;
}

/**
 * Runs one button and returns the screen to show next. The sender must own
 * the bridged conversation (the commands' own proof); otherwise the answer is
 * the "not available" text and nothing is read or written for the click.
 */
export async function runAgentsButtonAction(input: AgentsButtonActionInput): Promise<AgentsScreen> {
  const locale = await resolveBridgeLocale(input.db, input.boardUserId);
  const context = await loadBridgedCommandContext(input.db, {
    companyId: input.companyId,
    agentId: input.conversationAgentId,
    boardUserId: input.boardUserId,
    conversationIssueId: input.conversationIssueId,
  });
  if (!context) return plainScreen(locale, t(locale, "chat.notAvailable"));

  const stickyAgentId = readStickyAgentId(context.issue.assigneeAdapterOverrides);
  const currentId = stickyAgentId ?? input.conversationAgentId;
  const cards = await loadCompanyAgentCards(input.db, input.companyId);
  const unavailable = () => plainScreen(locale, t(locale, "agents.buttons.unavailable"));
  const action = input.action;

  switch (action.op) {
    case "groups":
      return buildGroupsScreen(cards, currentId, locale);
    case "group":
      return buildGroupScreen(cards, currentId, locale, action.group, action.page) ?? unavailable();
    case "agent":
      return buildAgentScreen(cards, currentId, locale, action.agentId) ?? unavailable();
    case "pick": {
      const card = cards.find((entry) => entry.id === action.agentId);
      if (!card || isHiddenAgentCard(card)) return unavailable();
      // The very same code as `/to <alias>`: one sticky-addressee write path.
      const result = await handleToCommand({
        db: input.db,
        companyId: input.companyId,
        conversationAgentId: input.conversationAgentId,
        issueId: input.conversationIssueId,
        boardUserId: input.boardUserId,
        args: card.id,
        stickyAgentId,
        locale,
      });
      return { title: card.name, text: result.text, buttons: [backButton(locale)] };
    }
    case "model": {
      const card = cards.find((entry) => entry.id === action.agentId);
      if (!card || isHiddenAgentCard(card)) return unavailable();
      const text = await buildAgentModelText(input.db, {
        companyId: input.companyId,
        agentId: card.id,
        overrides: context.issue.assigneeAdapterOverrides,
        locale,
        readGatewayModelCatalog: input.readGatewayModelCatalog,
      });
      if (text === null) return unavailable();
      return { title: card.name, text, buttons: [backButton(locale)] };
    }
    case "stop": {
      const card = cards.find((entry) => entry.id === action.agentId);
      if (!card || isHiddenAgentCard(card)) return unavailable();
      const result = await stopBridgedChatRuns({
        db: input.db,
        companyId: input.companyId,
        agentId: card.id,
        issueId: input.conversationIssueId,
        boardUserId: input.boardUserId,
        cancelRun: input.cancelRun,
      });
      const text = result.failed
        ? t(locale, "stop.unavailable")
        : result.stopped > 0
          ? t(locale, "stop.stopping")
          : t(locale, "stop.idle");
      return { title: card.name, text, buttons: [backButton(locale)] };
    }
  }
}

/** The `stageTaskControlPublication` shape the bridge and the action handler share. */
export type StageTaskControlPublication = (
  tx: Db,
  input: {
    companyId: string;
    conversationId: string;
    endpointId: string;
    idempotencyKey: string;
    issueId: string;
    payload: SafeChatPublicationPayload;
    principalId: string;
  },
) => Promise<{ id: string }>;

/**
 * Stages a screen as a `task_control` publication and issues one token per
 * button, in the caller's transaction. A screen without buttons goes out as a
 * plain message. The tokens are rows of the same table the question cards use;
 * a token is single-conversation and expires after `AGENTS_BUTTON_TTL_MS`.
 */
export async function stageAgentsScreenPublication(input: {
  tx: Db;
  stage: StageTaskControlPublication;
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string;
  principalId: string;
  idempotencyKey: string;
  screen: AgentsScreen;
  now?: Date;
}): Promise<{ id: string }> {
  const { screen } = input;
  const tokens = screen.buttons.map((button) => ({ actionId: createAgentsButtonToken(), button }));
  const payload = projectSafeChatPublication({
    classification: "external",
    source: "task_control",
    text: agentsScreenPlainText(screen),
    ...(tokens.length > 0
      ? {
          card: {
            kind: "status" as const,
            title: screen.title,
            body: screen.text,
            actions: tokens.map(({ actionId, button }) => ({
              type: "callback" as const,
              actionId,
              label: button.label,
              style: button.style ?? ("default" as const),
            })),
          },
        }
      : {}),
  });
  const publication = await input.stage(input.tx, {
    companyId: input.companyId,
    conversationId: input.conversationId,
    endpointId: input.endpointId,
    idempotencyKey: input.idempotencyKey,
    issueId: input.issueId,
    payload,
    principalId: input.principalId,
  });
  if (tokens.length > 0) {
    const expiresAt = new Date((input.now ?? new Date()).getTime() + AGENTS_BUTTON_TTL_MS).toISOString();
    await input.tx
      .insert(chatActions)
      .values(
        tokens.map(({ actionId, button }) => ({
          companyId: input.companyId,
          endpointId: input.endpointId,
          conversationId: input.conversationId,
          principalId: input.principalId,
          kind: AGENTS_BUTTON_ACTION_KIND,
          providerActionId: actionId,
          payload: {
            version: 1,
            publicationId: publication.id,
            expiresAt,
            action: button.action,
          },
          status: "issued",
        })),
      )
      .onConflictDoNothing();
  }
  return publication;
}

/** The soft refusal for a stale button: a plain message in the clicker's language. */
export async function buildAgentsExpiredScreen(db: Db, boardUserId: string): Promise<AgentsScreen> {
  const locale = await resolveBridgeLocale(db, boardUserId);
  return plainScreen(locale, t(locale, "agents.buttons.expired"));
}

/** What the transport tells `resolveAgentsButtonClick` about the click. */
export interface AgentsButtonClick {
  endpointId: string;
  companyId: string;
  /** `event.event.actionId` — the token. */
  actionId: string;
  /** The provider thread of the clicked message. */
  threadId: string;
  /** The provider id of the clicked message. */
  messageId: string;
  /** Telegram's raw `callback_data`, as received. */
  rawData: unknown;
  /** The Chat SDK `value` of the click; Telegram tokens never carry one. */
  value: unknown;
  /** The Chat SDK's thread match for this provider (it is not plain equality for every provider). */
  threadMatches: (actionThreadId: string, conversationThreadId: string) => boolean;
  now?: Date;
}

export type AgentsButtonClickResolution =
  | { kind: "deny"; conversationId: string | null }
  | {
      kind: "ok";
      token: typeof chatActions.$inferSelect;
      conversation: typeof chatConversations.$inferSelect;
      action: AgentsButtonPayload;
      expired: boolean;
    };

/**
 * Proves a click on an /agents button is one the bridge issued: the token is a
 * live `agents_button` row of this endpoint, bound to one Telegram direct
 * conversation, the clicked message is the very publication the token was
 * issued for, and Telegram's callback data is exactly the token's envelope.
 * It does not decide who may click — the caller checks the sender against the
 * conversation's owner.
 */
export async function resolveAgentsButtonClick(
  db: Db,
  click: AgentsButtonClick,
): Promise<AgentsButtonClickResolution> {
  const deny = (conversationId: string | null = null): AgentsButtonClickResolution => ({
    kind: "deny",
    conversationId,
  });
  const [token] = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, click.companyId),
        eq(chatActions.endpointId, click.endpointId),
        eq(chatActions.kind, AGENTS_BUTTON_ACTION_KIND),
        eq(chatActions.providerActionId, click.actionId),
      ),
    )
    .limit(1);
  if (!token || !token.conversationId) return deny();

  const data = click.rawData;
  if (
    typeof data !== "string" ||
    Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES ||
    data !== telegramChatSdkCallbackData(click.actionId) ||
    click.value !== undefined
  ) {
    return deny(token.conversationId);
  }

  const stored = token.payload;
  const action = parseAgentsButtonPayload(stored.action);
  const expiresAt = typeof stored.expiresAt === "string" ? Date.parse(stored.expiresAt) : Number.NaN;
  if (
    stored.version !== 1 ||
    typeof stored.publicationId !== "string" ||
    !action ||
    !Number.isFinite(expiresAt) ||
    token.status !== "issued"
  ) {
    return deny(token.conversationId);
  }

  const [conversation] = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.companyId, click.companyId),
        eq(chatConversations.endpointId, click.endpointId),
        eq(chatConversations.id, token.conversationId),
        inArray(chatConversations.state, ["active", "waiting"]),
      ),
    )
    .limit(1);
  if (
    !conversation ||
    !conversation.isDirectMessage ||
    !click.threadMatches(click.threadId, conversation.externalThreadId)
  ) {
    return deny(token.conversationId);
  }

  const [publication] = await db
    .select({ id: chatPublications.id })
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.companyId, click.companyId),
        eq(chatPublications.endpointId, click.endpointId),
        eq(chatPublications.conversationId, conversation.id),
        eq(chatPublications.id, stored.publicationId),
        eq(chatPublications.state, "published"),
        eq(chatPublications.providerMessageId, click.messageId),
      ),
    )
    .limit(1);
  if (!publication) return deny(conversation.id);

  return {
    kind: "ok",
    token,
    conversation,
    action,
    expired: expiresAt <= (click.now ?? new Date()).getTime(),
  };
}
