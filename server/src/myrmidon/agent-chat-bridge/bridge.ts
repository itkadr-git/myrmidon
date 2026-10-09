// myrmidon(X8b): Telegram direct messages become a standing Agent Chat
// conversation instead of a fresh per-session task. This file holds every
// piece of that logic; `chat-channels.ts` only calls into it (see the
// `myrmidon(X8b)` call sites there). See docs/myrmidon/DIVERGENCE.md, track 4.
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  IssueComment,
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import {
  publishActivity,
  type ActivityPublication,
  type logActivity,
} from "../../services/activity-log.js";
import { resumeConversationForReset } from "../../services/agent-conversations.js";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { safeChatTaskUrl } from "../../services/chat-task-url.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import type { issueService } from "../../services/issues.js";
import { stageAgentsScreenPublication } from "./commands/agents-buttons.js";
import {
  parseBridgedCommand,
  runBridgedChooserReply,
  runBridgedDirectMessageCommand,
} from "./commands/index.js";
// myrmidon(F06-D): the buttons under a `/model` or `/think` list, and the
// reply-pick from it.
import {
  buildChooserMenuPayload,
  findChooserListForReply,
  recordChooserMenu,
} from "./chooser-actions.js";
import {
  conversationChannel,
  conversationOwnerUserId,
  telegramConversationUserId,
  type ConversationKey,
} from "./identity.js";
import { telegramDmConversationsEnabled } from "./settings.js";
// myrmidon(1.7-TG-LOCALE): bridge-owned prose (migration notice, unlinked
// refusal) renders from the locale catalogs in the linked user's language.
import { resolveBridgeLocale, forcedBridgeLocale, DEFAULT_BRIDGE_LOCALE, t } from "./locales/index.js";
// myrmidon(X9b): @<alias> addressing — alias resolution plus the reply prefix
// and the first-contact context quote for an addressed agent's turn.
import { resolveBridgeAddressee, type TelegramAddressee } from "./addressing.js";
import { buildMentionedChatContext } from "./cross-channel.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
// myrmidon(X8b): mirrors chat-channels.ts's own local `DbOrTransaction` alias
// so a caller mid-transaction (`taskTx: Db | DbTransaction` there) can pass
// its handle straight through without a cast.
type DbOrTx = Db | DbTransaction;
type EndpointRow = typeof chatEndpoints.$inferSelect;
type ConversationRow = typeof chatConversations.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/** Minimal shape `stageProviderEffect`'s payload needs; the real type stays private to chat-channels.ts. */
interface TelegramDmProviderEffectPayload {
  version: 1;
  authorizationMode?: "principal" | "safe_notice";
  effect: "thread_message";
  threadId: string;
  text: string;
  settleDelivery: boolean;
  resourceId?: string;
}

/** External dependencies the bridge needs from chat-channels.ts's closure. */
export interface TelegramDmBridgeDeps {
  issuesSvc: Pick<ReturnType<typeof issueService>, "getConversation" | "create">;
  stageTaskControlPublication: (
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
  stageProviderEffect: (
    database: Db,
    input: {
      endpoint: EndpointRow;
      deliveryId?: string | null;
      conversationId?: string | null;
      principalId?: string | null;
      providerActionId: string;
      payload: TelegramDmProviderEffectPayload;
      runtimeContext: { credentialFingerprint: string; generation: number };
    },
  ) => Promise<{ id: string } | null>;
  processProviderEffect: (
    actionId: string,
    liveTarget?: { post: (...args: any[]) => any; postEphemeral?: (...args: any[]) => any },
  ) => Promise<"processed" | "pending" | "failed" | "delivery_unknown">;
  logActivity: typeof logActivity;
  publicBaseUrl: string | null;
  cancelRun?: (
    runId: string,
    reason: string,
    options: { errorCode?: string; resultJson?: Record<string, unknown> },
  ) => Promise<unknown>;
}

export interface TelegramDmBindingDecision {
  applies: boolean;
  detachExisting: boolean;
  releaseConversationId?: string;
  migratedFromIssueId?: string;
}

/** The old issue's identity: enough of it to classify and, if needed, link back to it. */
type ExistingIssueRef = ConversationKey & { id: string };

/**
 * Decides whether this inbound message belongs to a bridged Telegram DM
 * conversation, and whether the thread's current binding (if any) must be
 * released first. Read-only: callers apply `releaseConversationId` /
 * `existingConversation = null` themselves, under their own transaction.
 */
export async function decideTelegramDmBinding(
  db: Db,
  input: {
    endpoint: { provider: string; id: string; assignedAgentId: string };
    isDirectMessage: boolean;
    boardUserId: string | null;
    existingConversation: { id: string; state: string } | null;
    existingIssue: ExistingIssueRef | null;
  },
): Promise<TelegramDmBindingDecision> {
  const applies =
    input.endpoint.provider === "telegram" &&
    input.isDirectMessage &&
    input.boardUserId !== null &&
    telegramDmConversationsEnabled(input.endpoint.id) &&
    (await instanceSettingsService(db).getExperimental()).enableAgentChat === true;

  const boundToTelegramConversation =
    input.existingIssue !== null &&
    conversationChannel(input.existingIssue) === "telegram";

  if (applies) {
    const stillOpen =
      input.existingConversation !== null &&
      (input.existingConversation.state === "active" ||
        input.existingConversation.state === "waiting");
    const boundHere =
      boundToTelegramConversation &&
      conversationOwnerUserId(input.existingIssue) === input.boardUserId &&
      input.existingIssue!.conversationAgentId ===
        input.endpoint.assignedAgentId &&
      stillOpen;
    if (boundHere) return { applies: true, detachExisting: false };
    if (input.existingConversation) {
      return {
        applies: true,
        detachExisting: true,
        ...(stillOpen
          ? { releaseConversationId: input.existingConversation.id }
          : {}),
        ...(input.existingIssue &&
        conversationChannel(input.existingIssue) === null
          ? { migratedFromIssueId: input.existingIssue.id }
          : {}),
      };
    }
    return { applies: true, detachExisting: false };
  }

  if (boundToTelegramConversation && input.existingConversation) {
    return {
      applies: false,
      detachExisting: true,
      releaseConversationId: input.existingConversation.id,
    };
  }
  return { applies: false, detachExisting: false };
}

/** The text of the one-time notice sent when a thread migrates onto the standing conversation. */
async function buildMigrationNoticeText(
  db: DbOrTx,
  input: {
    companyId: string;
    agentId: string;
    publicBaseUrl: string | null;
    migratedFromIssueId: string;
    /** myrmidon(1.7-TG-LOCALE): the linked board user whose language decides the notice. */
    boardUserId: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string> {
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  const link = safeChatTaskUrl(input.publicBaseUrl, input.migratedFromIssueId);
  // myrmidon(1.7-TG-LOCALE): this notice is read in the bridged Telegram DM,
  // so it renders in the linked user's locale like the command surface.
  const locale = await resolveBridgeLocale(db as unknown as Db, input.boardUserId, input.env);
  return t(locale, "bridge.migrated", {
    agent: agent?.name ?? t(locale, "bridge.thisAgent"),
    linkSuffix: link ? t(locale, "bridge.linkWith", { url: link }) : t(locale, "bridge.linkNone"),
  });
}

const MAX_LOGGED_ERROR_TEXT = 2_000;

/**
 * Mirrors chat-channels.ts's own module-private `redactError`: a raw error
 * from a Telegram Bot API call can carry the bot token in the request URL,
 * so it must never reach logs unredacted. `redactSensitiveText` is a shared,
 * exported helper (server/src/redaction.ts); the Telegram-token-shaped regex
 * below is duplicated because the vendor's own copy is not exported. See
 * docs/myrmidon/DIVERGENCE.md, track 4 (X8b): keep this in sync if the
 * vendor's `redactError` regex changes.
 */
function redactTelegramDmError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const withoutTelegramBotTokens = text
    .replace(/(\/bot)\d{5,}(?::|%3A)[A-Za-z0-9_-]{20,}/gi, "$1***REDACTED***")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "***REDACTED***");
  return redactSensitiveText(withoutTelegramBotTokens).slice(0, MAX_LOGGED_ERROR_TEXT);
}

/**
 * Gets or creates the standing Telegram conversation issue for
 * (agent, boardUserId).
 * myrmidon(X9b): `input.agentId` may be a company agent other than the
 * endpoint's assigned agent — an @<alias>-addressed turn gets its own
 * standing conversation with the same `telegram:<boardUserId>` key (the
 * vendor's unique index is `(companyId, conversationAgentId,
 * conversationUserId)`, so the same key with a different agent is a distinct
 * row).
 */
export async function ensureTelegramDmConversation(
  tx: DbOrTx,
  deps: TelegramDmBridgeDeps,
  input: {
    companyId: string;
    agentId: string;
    endpointId: string;
    boardUserId: string;
  },
  publications: ActivityPublication[],
): Promise<IssueRow> {
  const conversationUserId = telegramConversationUserId(input.boardUserId);
  const existing = await deps.issuesSvc.getConversation(
    input.companyId,
    input.agentId,
    conversationUserId,
  );
  if (existing) return existing;
  const [agent] = await tx
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  const issue = await deps.issuesSvc.create(
    input.companyId,
    {
      title: `Telegram chat with ${agent?.name ?? "this agent"}`,
      assigneeAgentId: input.agentId,
      conversationAgentId: input.agentId,
      conversationUserId,
      conversationState: "waiting",
      status: "in_review",
      createdByUserId: input.boardUserId,
    },
    tx,
  );
  await deps.logActivity(
    tx as unknown as Db,
    {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.boardUserId,
      action: "issue.conversation_opened",
      entityType: "issue",
      entityId: issue.id,
      // myrmidon(X9b): `details.agentId` names the conversation's own agent,
      // which an addressed turn may differ from the endpoint's assigned agent.
      details: { agentId: input.agentId, channel: "telegram", endpointId: input.endpointId },
    },
    publications,
  );
  return issue;
}

/**
 * Gets or creates the `chat_conversations` row (a native-thread binding, one
 * generation) that ties this Telegram DM thread to the standing conversation
 * issue for (agent, boardUserId).
 * myrmidon(X9b): `input.conversationAgentId` routes the binding to a
 * company agent other than the endpoint's assigned one (an @<alias>-addressed
 * turn). Omitted/undefined keeps the assigned agent — the pre-X9b path, byte
 * for byte. When the resolved addressee IS the assigned agent, the caller
 * passes it and the behavior is identical either way.
 */
export async function ensureTelegramDmBinding(
  tx: DbOrTx,
  deps: TelegramDmBridgeDeps,
  input: {
    endpoint: EndpointRow;
    resource: { id: string; label: string };
    thread: { id: string; channelId: string };
    providerUrl: string | null;
    boardUserId: string;
    current: ConversationRow | null;
    latestConversation: { sessionGeneration: number } | null;
    /** myrmidon(X9b): the @<alias>-addressed agent, when one was resolved. */
    conversationAgentId?: string;
  },
  publications: ActivityPublication[],
): Promise<{ conversation: ConversationRow; issue: IssueRow }> {
  const issue = await ensureTelegramDmConversation(
    tx,
    deps,
    {
      companyId: input.endpoint.companyId,
      agentId: input.conversationAgentId ?? input.endpoint.assignedAgentId,
      endpointId: input.endpoint.id,
      boardUserId: input.boardUserId,
    },
    publications,
  );
  if (
    input.current &&
    input.current.issueId === issue.id &&
    (input.current.state === "active" || input.current.state === "waiting")
  ) {
    return { conversation: input.current, issue };
  }
  if (
    input.current &&
    (input.current.state === "active" || input.current.state === "waiting")
  ) {
    await tx
      .update(chatConversations)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(chatConversations.id, input.current.id));
  }
  const sessionGeneration = (input.latestConversation?.sessionGeneration ?? 0) + 1;
  await tx
    .insert(chatConversations)
    .values({
      companyId: input.endpoint.companyId,
      endpointId: input.endpoint.id,
      resourceId: input.resource.id,
      issueId: issue.id,
      externalConversationId: input.thread.channelId,
      externalThreadId: input.thread.id,
      sessionGeneration,
      externalLabel: input.resource.label,
      providerUrl: input.providerUrl,
      isDirectMessage: true,
      state: "active",
      lastActivityAt: new Date(),
    })
    .onConflictDoNothing();
  const conversation = await tx
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.endpointId, input.endpoint.id),
        eq(chatConversations.externalConversationId, input.thread.channelId),
        eq(chatConversations.externalThreadId, input.thread.id),
        eq(chatConversations.sessionGeneration, sessionGeneration),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!conversation) {
    throw new Error("myrmidon(X8b): could not bind the Telegram DM conversation");
  }
  return { conversation, issue };
}

/**
 * myrmidon(F06-D): the commands an EDITED message may still run. A person who
 * fixes a typo in `/modle` (or turns `/model` into `/model 3`) expects the
 * command to run, not a silent nothing. Only commands that answer with a reply
 * and leave the standing conversation's task untouched qualify: `/new` (which
 * becomes a task comment), `/plan` and `/accept`/`/reject` (which create or
 * close work) are never re-run from an edit.
 */
const EDITABLE_BRIDGED_COMMANDS: ReadonlySet<string> = new Set([
  "model",
  "think",
  "status",
  "help",
  "start",
  "commands",
  "stop",
  "agents",
  "who",
]);

const EDITED_MESSAGE_PREFIX = "An external message was edited:\n\n";

/**
 * The command text of a Telegram message-edit lifecycle event (its text is
 * wrapped as «An external message was edited: …»), or null when the edited
 * message is not a command that may be re-run.
 */
export function editedBridgedCommandText(lifecycleText: string): string | null {
  if (!lifecycleText.startsWith(EDITED_MESSAGE_PREFIX)) return null;
  const body = lifecycleText.slice(EDITED_MESSAGE_PREFIX.length).trim();
  const parsed = parseBridgedCommand(body);
  return parsed && EDITABLE_BRIDGED_COMMANDS.has(parsed.name) ? body : null;
}

/**
 * Handles a bridged-DM message that may be an OpenClaw-style command.
 * Returns `done: true` when the whole inbound turn is finished (a `reply`
 * command already published its own answer); otherwise the caller continues
 * its normal comment/wakeup flow, optionally with an overridden body/notice
 * (a `message`-kind command result).
 */
export async function handleTelegramDmCommand(input: {
  db: Db;
  deps: TelegramDmBridgeDeps;
  endpoint: EndpointRow;
  resource: { id: string; label: string };
  thread: { id: string; channelId: string };
  providerUrl: string | null;
  boardUserId: string;
  deliveryId: string;
  principalId: string;
  text: string;
  current: ConversationRow | null;
  latestConversation: { sessionGeneration: number } | null;
  // myrmidon(X8b): `decideTelegramDmBinding`'s own release/migration fields.
  // A `reply`-kind command result finishes the whole turn in this function
  // (the caller never reaches persistTaskMutation/afterTelegramDmMessage in
  // chat-channels.ts), so this is the only place left that can release the
  // thread's old binding and queue the migration notice for a transition
  // whose first message happens to be a recognized command.
  releaseConversationId?: string;
  migratedFromIssueId?: string;
  /**
   * myrmidon(F06-D): the provider message this message replies to, in the form
   * `chat_message_links` stores (Telegram: `<chat id>:<message id>`). A plain
   * reply to a `/model` or `/think` list picks from it.
   */
  replyToProviderMessageId?: string | null;
}): Promise<{ done: true } | { done: false; body?: string; notice?: string }> {
  const parsed = parseBridgedCommand(input.text);
  // myrmidon(F06-D): not a command — but a reply to one of our choice lists may
  // still be a pick ("2", "glm-5.3"). One cheap lookup, only for replies.
  const chooserList =
    !parsed && input.replyToProviderMessageId
      ? await findChooserListForReply(input.db, {
          companyId: input.endpoint.companyId,
          endpointId: input.endpoint.id,
          replyToProviderMessageId: input.replyToProviderMessageId,
        })
      : null;
  if (!parsed && !chooserList) return { done: false };
  const commandPublications: ActivityPublication[] = [];
  const bound = await input.db.transaction(async (tx) => {
    if (input.releaseConversationId) {
      await tx
        .update(chatConversations)
        .set({ state: "completed", updatedAt: new Date() })
        .where(
          and(
            eq(chatConversations.id, input.releaseConversationId),
            inArray(chatConversations.state, ["active", "waiting"]),
          ),
        );
    }
    return ensureTelegramDmBinding(
      tx,
      input.deps,
      {
        endpoint: input.endpoint,
        resource: input.resource,
        thread: input.thread,
        providerUrl: input.providerUrl,
        boardUserId: input.boardUserId,
        current: input.current,
        latestConversation: input.latestConversation,
      },
      commandPublications,
    );
  });
  for (const publication of commandPublications) publishActivity(publication);
  const result = chooserList
    ? // The list belongs to one conversation; a reply from another is plain text.
      chooserList.conversationId === bound.conversation.id
      ? await runBridgedChooserReply({
          db: input.db,
          companyId: input.endpoint.companyId,
          agentId: input.endpoint.assignedAgentId,
          conversationIssueId: bound.issue.id,
          boardUserId: input.boardUserId,
          commandName: chooserList.commandName,
          text: input.text,
        })
      : null
    : await runBridgedDirectMessageCommand({
        db: input.db,
        companyId: input.endpoint.companyId,
        agentId: input.endpoint.assignedAgentId,
        endpointId: input.endpoint.id,
        deliveryId: input.deliveryId,
        boardUserId: input.boardUserId,
        conversationIssueId: bound.issue.id,
        text: input.text,
        publicBaseUrl: input.deps.publicBaseUrl,
        cancelRun:
          input.deps.cancelRun ??
          (async () => {
            throw new Error("chat_cancel_unavailable");
          }),
      });
  if (result === null) return { done: false };
  if (result.kind === "message") {
    return { done: false, body: result.body, notice: result.notice };
  }
  await input.db.transaction(async (tx) => {
    await tx
      .update(chatEndpoints)
      .set({ lastEventAt: new Date(), updatedAt: new Date() })
      .where(eq(chatEndpoints.id, input.endpoint.id));
    await tx
      .update(chatDeliveries)
      .set({
        conversationId: bound.conversation.id,
        state: "processed",
        processedAt: new Date(),
        redactedError: null,
        updatedAt: new Date(),
      })
      .where(eq(chatDeliveries.id, input.deliveryId));
    if (result.screen) {
      // myrmidon(1.6.5 OPE-6318 part B): /agents as a card with buttons; the
      // button tokens are issued in this same transaction.
      await stageAgentsScreenPublication({
        tx: tx as unknown as Db,
        stage: input.deps.stageTaskControlPublication,
        companyId: input.endpoint.companyId,
        endpointId: input.endpoint.id,
        conversationId: bound.conversation.id,
        issueId: bound.issue.id,
        principalId: input.principalId,
        idempotencyKey: `control:x8-${result.command}:${input.deliveryId}`,
        screen: result.screen,
      });
    } else {
      // myrmidon(F06-D): a `/model` or `/think` list goes out as a menu — buttons
      // where the endpoint takes actions, and always a record a reply can pick
      // from.
      const menu = result.choices ?? null;
      const menuPayload = menu
        ? buildChooserMenuPayload({
            text: result.text,
            menu,
            withButtons: input.endpoint.capabilities?.actions === true,
          })
        : null;
      const staged = await input.deps.stageTaskControlPublication(tx as unknown as Db, {
        companyId: input.endpoint.companyId,
        endpointId: input.endpoint.id,
        conversationId: bound.conversation.id,
        issueId: bound.issue.id,
        idempotencyKey: `control:x8-${result.command}:${input.deliveryId}`,
        payload:
          menuPayload?.payload ??
          projectSafeChatPublication({
            classification: "external",
            source: "task_control",
            text: result.text,
          }),
        principalId: input.principalId,
      });
      if (menu && menuPayload) {
        await recordChooserMenu(tx, {
          companyId: input.endpoint.companyId,
          endpointId: input.endpoint.id,
          conversationId: bound.conversation.id,
          principalId: input.principalId,
          publicationId: staged.id,
          menu,
          tokens: menuPayload.tokens,
        });
      }
    }
    if (input.migratedFromIssueId) {
      const text = await buildMigrationNoticeText(tx as unknown as Db, {
        companyId: input.endpoint.companyId,
        agentId: input.endpoint.assignedAgentId,
        publicBaseUrl: input.deps.publicBaseUrl,
        migratedFromIssueId: input.migratedFromIssueId,
        boardUserId: input.boardUserId,
      });
      await input.deps.stageTaskControlPublication(tx as unknown as Db, {
        companyId: input.endpoint.companyId,
        endpointId: input.endpoint.id,
        conversationId: bound.conversation.id,
        issueId: bound.issue.id,
        idempotencyKey: `control:x8-migrated:${input.deliveryId}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "task_control",
          text,
        }),
        principalId: input.principalId,
      });
    }
  });
  return { done: true };
}

/**
 * Refuses an unlinked Telegram account writing to a bridged bot's DM, once
 * per account per UTC day. `stageProviderEffect`'s own unique
 * `providerActionId` is the dedupe key, so a repeat within the same day is a
 * silent no-op.
 */
export async function refuseUnlinkedTelegramDm(
  db: Db,
  deps: TelegramDmBridgeDeps,
  input: {
    endpoint: EndpointRow;
    thread: { id: string; post: (...args: any[]) => any };
    principalId: string;
    deliveryId: string | null;
    resourceId: string;
    runtimeContext: { credentialFingerprint: string; generation: number };
    /** myrmidon(1.7-TG-LOCALE): test seam for the forced-locale env. */
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  // myrmidon(1.7-TG-LOCALE): an unlinked account has no board user, so the
  // refusal follows the instance decision only: the env force, else the
  // English default.
  const locale = forcedBridgeLocale(input.env ?? process.env) ?? DEFAULT_BRIDGE_LOCALE;
  try {
    const effect = await deps.stageProviderEffect(db, {
      endpoint: input.endpoint,
      deliveryId: input.deliveryId,
      principalId: input.principalId,
      providerActionId: `provider_effect:x8-refusal:${input.endpoint.id}:${input.principalId}:${day}`,
      payload: {
        version: 1,
        authorizationMode: "safe_notice",
        effect: "thread_message",
        threadId: input.thread.id,
        text: t(locale, "bridge.refusalUnlinked"),
        settleDelivery: false,
        resourceId: input.resourceId,
      },
      runtimeContext: input.runtimeContext,
    });
    if (effect) await deps.processProviderEffect(effect.id, input.thread);
  } catch (error) {
    // myrmidon(X8b): never log the raw error — a Telegram Bot API failure
    // can carry the bot token in its request URL (see redactTelegramDmError).
    logger.warn(
      { endpointId: input.endpoint.id, error: redactTelegramDmError(error) },
      "myrmidon(X8b): unlinked Telegram DM refusal notice failed",
    );
  }
}

/**
 * Post-commit follow-up for a bridged DM message: resumes a paused
 * conversation on `/new`, and sends the queued notice(s) — the migration
 * notice at most once per (endpoint, old issue).
 */
export async function afterTelegramDmMessage(input: {
  db: Db;
  deps: TelegramDmBridgeDeps;
  // myrmidon(X8b): the caller's `comment` is `issuesSvc.addComment`'s return
  // value (the shared `IssueComment` API shape), not the raw drizzle select
  // row `resumeConversationForReset` takes; the two differ only in which
  // optional columns are typed `| undefined`, so the forwarding call below
  // casts rather than widening the vendor helper's own parameter type.
  comment: IssueComment;
  agentId: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string;
  deliveryId: string;
  principalId: string;
  /** myrmidon(1.7-TG-LOCALE): linked board user; decides the notice's language. */
  boardUserId?: string;
  notice?: string;
  migratedFromIssueId?: string;
}): Promise<void> {
  // myrmidon(X8a/X8b): the bridged command dispatcher (commands/index.ts,
  // canon from X8a) already recognizes both "/new" and "/new@<bot username>"
  // — Telegram clients append the bot's username in a group, and a person
  // may paste it into a DM out of habit too — and normalizes either one to
  // a literal "/new" *before* chat-channels.ts persists the comment (the
  // `x8MessageBody` override there). So by the time this runs, a reset
  // always shows up as an exact "/new"; `resumeConversationForReset` itself
  // compares the comment's raw `body` against that literal
  // (agent-conversations.ts, not ours to change), so a plain equality check
  // is enough here.
  if (input.comment.body === "/new") {
    await resumeConversationForReset(
      input.db,
      input.comment as unknown as Parameters<typeof resumeConversationForReset>[1],
    );
  }
  if (input.notice) {
    await input.db.transaction((tx) =>
      input.deps.stageTaskControlPublication(tx as unknown as Db, {
        companyId: input.companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        issueId: input.issueId,
        idempotencyKey: `control:x8-notice:${input.deliveryId}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "task_control",
          text: input.notice!,
        }),
        principalId: input.principalId,
      }),
    );
  }
  if (input.migratedFromIssueId) {
    const text = await buildMigrationNoticeText(input.db, {
      companyId: input.companyId,
      agentId: input.agentId,
      publicBaseUrl: input.deps.publicBaseUrl,
      migratedFromIssueId: input.migratedFromIssueId,
      // myrmidon(1.7-TG-LOCALE): the migration only runs for a linked person
      // (x8Dm.applies requires a board user); an unlinked thread's old
      // binding never reaches this path.
      boardUserId: input.boardUserId ?? "",
    });
    await input.db.transaction((tx) =>
      input.deps.stageTaskControlPublication(tx as unknown as Db, {
        companyId: input.companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        issueId: input.issueId,
        idempotencyKey: `control:x8-migrated:${input.deliveryId}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "task_control",
          text,
        }),
        principalId: input.principalId,
      }),
    );
  }
}

// myrmidon(X9b) -------------------------------------------------------------
// @<alias> addressing: routing an inbound Telegram turn to an addressed
// company agent, prefixing that agent's reply, and quoting the chat's recent
// messages into its first turn.

/**
 * myrmidon(X9b): resolves the @<alias> addressee of an inbound bridged
 * Telegram message. Only same-company agents match (resolveBridgeAddressee
 * scopes the lookup to `companyId`); a message with no resolvable @-token
 * returns null and the turn keeps the vendor/X8b assigned-agent path, byte
 * for byte.
 */
export async function resolveBridgedAddressee(
  db: Db,
  input: {
    companyId: string;
    endpointAgentId: string;
    text: string;
  },
): Promise<TelegramAddressee | null> {
  return resolveBridgeAddressee(db, input);
}

/**
 * myrmidon(X9b): the prefix an addressed agent's reply carries in the
 * Telegram chat it was mentioned in — `[<displayName>]`, mirroring the
 * Russian-display-name example in the task. Only an actually-addressed agent
 * (not the endpoint's assigned agent answering its own conversation) gets a
 * prefix: the assigned agent's replies are already the chat's own voice.
 */
export function addressedReplyPrefix(displayName: string): string {
  return `[${displayName}] `;
}

/**
 * myrmidon(X9b): stages and delivers an addressed agent's reply into the same
 * Telegram `thread`/`resource` of the same endpoint through the bridge's
 * existing `stageProviderEffect` -> `processProviderEffect` lane, prefixed
 * with the agent's display name. `liveTarget` is the caller's thread double
 * (chat-channels.ts passes the exact `thread` it received for this delivery).
 */
export async function sendAddressedAgentReply(
  db: Db,
  deps: TelegramDmBridgeDeps,
  input: {
    endpoint: EndpointRow;
    thread: { id: string; post: (...args: any[]) => any };
    resourceId: string;
    principalId: string;
    deliveryId: string | null;
    /** The addressed agent's conversation row id, for the effect's own binding. */
    conversationId?: string | null;
    displayName: string;
    text: string;
    runtimeContext: { credentialFingerprint: string; generation: number };
  },
): Promise<void> {
  const prefixed = `${addressedReplyPrefix(input.displayName)}${input.text}`;
  const effect = await deps.stageProviderEffect(db, {
    endpoint: input.endpoint,
    conversationId: input.conversationId ?? null,
    deliveryId: input.deliveryId,
    principalId: input.principalId,
    providerActionId: `provider_effect:x9-reply:${input.deliveryId ?? "unknown"}`,
    payload: {
      version: 1,
      effect: "thread_message",
      threadId: input.thread.id,
      text: prefixed,
      settleDelivery: false,
      resourceId: input.resourceId,
    },
    runtimeContext: input.runtimeContext,
  });
  if (effect) await deps.processProviderEffect(effect.id, input.thread);
}
