// myrmidon(F06-D): the buttons and the reply-pick of a `/model` or `/think`
// list in a bridged Telegram DM.
//
// A plain `/model` (or `/think`) answers with a numbered list. This module
// turns that list into an interactive menu without touching the issue-
// interaction machinery (cards that resolve a task question): the list is a
// task-control publication whose card carries one opaque callback token per
// choice, and every token is a durable `chat_actions` row.
//
//   kind `chooser_list` — one per list message: marks the publication as a
//     choice list, so a plain reply with a number or a name can pick from it;
//   kind `chooser_pick` — one per button: the choice a press stands for.
//
// A press is trusted only through the token: the row names the publication,
// the conversation and the value; the clicked message must be that
// publication's own outbound message; the clicker must be the conversation's
// own linked person (the same check `/model <x>` makes). The value is then
// resolved against the live candidates again by `runBridgedChooserPick`, so a
// stale or forged token cannot write anything the command itself would refuse.
//
// This is a fork-owned module (server/src/myrmidon/...); chat-channels.ts only
// calls into it (the `myrmidon(F06-D)` call sites there).

import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  chatActions,
  chatConversations,
  chatMessageLinks,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
  SafeExternalChatCardAction,
} from "@paperclipai/shared";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import {
  runBridgedChooserPick,
  type BridgedChoiceMenu,
  type BridgedChooserSeams,
} from "./commands/index.js";
import { conversationChannel, conversationOwnerUserId } from "./identity.js";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export const CHOOSER_PICK_ACTION_KIND = "chooser_pick";
export const CHOOSER_LIST_ACTION_KIND = "chooser_list";

/** How long a list's buttons and its reply-pick stay live. */
export const CHOOSER_ACTION_TTL_MS = 24 * 60 * 60 * 1_000;

/** Choices per keyboard row: model ids are long, two per row stay readable. */
export const CHOOSER_BUTTONS_PER_ROW = 2;

const CHOOSER_ACTION_PREFIX = "pcm:";
const CHOOSER_ACTION_ID_RE = /^pcm:[A-Za-z0-9_-]{22}$/;

/** An opaque callback token (fits Telegram's 64-byte callback_data envelope). */
export function createChooserActionToken(): string {
  return `${CHOOSER_ACTION_PREFIX}${randomBytes(16).toString("base64url")}`;
}

export function isChooserActionId(value: unknown): value is string {
  return typeof value === "string" && CHOOSER_ACTION_ID_RE.test(value);
}

function chooserListActionId(publicationId: string): string {
  return `chooser-list:${publicationId}`;
}

/** Whether a stored card is a choice list (its buttons are laid out in rows). */
export function isChooserCardActions(
  actions: readonly SafeExternalChatCardAction[] | undefined,
): boolean {
  return (
    !!actions &&
    actions.length > 0 &&
    actions.every((action) => action.type === "callback" && isChooserActionId(action.actionId))
  );
}

export interface ChooserMenuPayload {
  payload: SafeChatPublicationPayload;
  /** One token per option, in the card's order. */
  tokens: Array<{ actionId: string; option: BridgedChoiceMenu["options"][number] }>;
}

/**
 * The publication payload of a choice list. With `withButtons` the card carries
 * the buttons and its title/body are the visible text (Telegram shows a card's
 * title and body, not the fallback text); without them the payload is the plain
 * text, and the list still answers to a reply.
 */
export function buildChooserMenuPayload(input: {
  text: string;
  menu: BridgedChoiceMenu;
  withButtons: boolean;
}): ChooserMenuPayload {
  const tokens = input.withButtons
    ? input.menu.options.map((option) => ({ actionId: createChooserActionToken(), option }))
    : [];
  const payload = projectSafeChatPublication({
    classification: "external",
    source: "task_control",
    text: input.text,
    card: input.withButtons
      ? {
          kind: "status",
          title: input.menu.title,
          body: input.menu.body,
          actions: tokens.map(({ actionId, option }) => ({
            type: "callback" as const,
            actionId,
            label: option.label,
          })),
        }
      : null,
  });
  return { payload, tokens };
}

/**
 * Records the durable side of a staged choice list — call it in the same
 * transaction that stages the publication. The list row is always written (a
 * reply can pick even where there are no buttons); a token row per button.
 */
export async function recordChooserMenu(
  tx: DbOrTx,
  input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    principalId: string;
    publicationId: string;
    menu: BridgedChoiceMenu;
    tokens: ChooserMenuPayload["tokens"];
    now?: Date;
  },
): Promise<void> {
  const expiresAt = new Date((input.now ?? new Date()).getTime() + CHOOSER_ACTION_TTL_MS).toISOString();
  const key = input.menu.commandName === "model" ? "model" : "effort";
  await tx
    .insert(chatActions)
    .values({
      companyId: input.companyId,
      endpointId: input.endpointId,
      conversationId: input.conversationId,
      principalId: input.principalId,
      kind: CHOOSER_LIST_ACTION_KIND,
      providerActionId: chooserListActionId(input.publicationId),
      payload: {
        version: 1,
        publicationId: input.publicationId,
        commandName: input.menu.commandName,
        key,
        expiresAt,
      },
      status: "issued",
    })
    .onConflictDoNothing();
  if (input.tokens.length === 0) return;
  await tx
    .insert(chatActions)
    .values(
      input.tokens.map(({ actionId, option }) => ({
        companyId: input.companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        principalId: input.principalId,
        kind: CHOOSER_PICK_ACTION_KIND,
        providerActionId: actionId,
        payload: {
          version: 1,
          publicationId: input.publicationId,
          commandName: input.menu.commandName,
          key,
          value: option.value,
          expiresAt,
        },
        status: "issued",
      })),
    )
    .onConflictDoNothing();
}

/**
 * The command (`model` or `think`) of the choice list a Telegram reply points
 * at, or null when the replied-to message is not a live choice list of this
 * endpoint. Cheap on purpose — it runs for every reply in a bridged DM.
 */
export async function findChooserListForReply(
  db: DbOrTx,
  input: {
    companyId: string;
    endpointId: string;
    replyToProviderMessageId: string;
    now?: Date;
  },
): Promise<{ commandName: "model" | "think"; conversationId: string } | null> {
  const link = await db
    .select({
      publicationId: chatMessageLinks.publicationId,
      conversationId: chatMessageLinks.conversationId,
    })
    .from(chatMessageLinks)
    .where(
      and(
        eq(chatMessageLinks.companyId, input.companyId),
        eq(chatMessageLinks.endpointId, input.endpointId),
        eq(chatMessageLinks.providerMessageId, input.replyToProviderMessageId),
        eq(chatMessageLinks.direction, "outbound"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!link?.publicationId) return null;
  const list = await db
    .select({ payload: chatActions.payload, status: chatActions.status })
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, input.companyId),
        eq(chatActions.endpointId, input.endpointId),
        eq(chatActions.kind, CHOOSER_LIST_ACTION_KIND),
        eq(chatActions.providerActionId, chooserListActionId(link.publicationId)),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!list || list.status !== "issued") return null;
  const payload = list.payload;
  const expiresAt = typeof payload.expiresAt === "string" ? Date.parse(payload.expiresAt) : Number.NaN;
  if (
    payload.version !== 1 ||
    payload.publicationId !== link.publicationId ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= (input.now ?? new Date()).getTime() ||
    (payload.commandName !== "model" && payload.commandName !== "think")
  ) {
    return null;
  }
  return { commandName: payload.commandName, conversationId: link.conversationId };
}

export type ChooserPickOutcome =
  /** The press was a chooser press and has been dealt with (applied, refused or a duplicate). */
  | { kind: "handled" }
  /** The press is not one this module can honour; the caller denies it. */
  | { kind: "denied"; principalConversationId: string | null };

/**
 * A button press under a choice list. The caller has already authenticated the
 * provider callback, resolved the endpoint and the clicking person (a linked,
 * active, non-bot board user) and checked the endpoint can take actions; this
 * does everything else. It never throws for a bad press — it returns `denied`.
 */
export async function handleChooserPick(input: {
  db: Db;
  companyId: string;
  endpointId: string;
  /** The callback's opaque action id (`pcm:…`). */
  actionId: string;
  /** The clicked provider message, in the form chat_message_links stores. */
  messageId: string;
  /** The clicking person's board user and external principal. */
  userId: string;
  principalId: string;
  /** The provider-thread check the generic action handler uses. */
  threadMatches: (conversationExternalThreadId: string) => boolean;
  /** Re-checks, inside the staging transaction, that the clicker is still authorized. */
  assertStillAuthorized: (tx: DbOrTx, conversationId: string) => Promise<void>;
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
  /** Test seams of the command layer (production leaves them unset). */
  commandSeams?: BridgedChooserSeams;
  now?: Date;
}): Promise<ChooserPickOutcome> {
  const { db } = input;
  const denied = (principalConversationId: string | null = null): ChooserPickOutcome => ({
    kind: "denied",
    principalConversationId,
  });

  const token = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, input.companyId),
        eq(chatActions.endpointId, input.endpointId),
        eq(chatActions.kind, CHOOSER_PICK_ACTION_KIND),
        eq(chatActions.providerActionId, input.actionId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!token?.conversationId) return denied();

  // A token already used (or its list answered by another choice) is stale, not
  // hostile: the person pressed an old button. Nothing to write, nothing to deny.
  if (token.status === "processed" || token.status === "processing" || token.status === "expired") {
    return { kind: "handled" };
  }
  if (token.status !== "issued") return denied(token.conversationId);

  const payload = token.payload;
  const expiresAt = typeof payload.expiresAt === "string" ? Date.parse(payload.expiresAt) : Number.NaN;
  if (
    payload.version !== 1 ||
    typeof payload.publicationId !== "string" ||
    typeof payload.value !== "string" ||
    (payload.commandName !== "model" && payload.commandName !== "think") ||
    !Number.isFinite(expiresAt)
  ) {
    return denied(token.conversationId);
  }
  if (expiresAt <= (input.now ?? new Date()).getTime()) {
    await db
      .update(chatActions)
      .set({ status: "expired", result: { code: "chooser_pick_expired" }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "issued")));
    return { kind: "handled" };
  }
  const publicationId: string = payload.publicationId;
  const commandName: "model" | "think" = payload.commandName;
  const pickValue: string = payload.value;

  const conversation = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.companyId, input.companyId),
        eq(chatConversations.endpointId, input.endpointId),
        eq(chatConversations.id, token.conversationId),
        inArray(chatConversations.state, ["active", "waiting"]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!conversation || !conversation.isDirectMessage || !input.threadMatches(conversation.externalThreadId)) {
    return denied(token.conversationId);
  }

  // The clicked message has to be this token's own list message.
  const link = await db
    .select({ id: chatMessageLinks.id })
    .from(chatMessageLinks)
    .where(
      and(
        eq(chatMessageLinks.companyId, input.companyId),
        eq(chatMessageLinks.endpointId, input.endpointId),
        eq(chatMessageLinks.conversationId, conversation.id),
        eq(chatMessageLinks.publicationId, publicationId),
        eq(chatMessageLinks.providerMessageId, input.messageId),
        eq(chatMessageLinks.direction, "outbound"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!link) return denied(conversation.id);

  // The press acts on this conversation's own issue, as its own linked person.
  const issue = await db
    .select({
      id: issues.id,
      conversationAgentId: issues.conversationAgentId,
      conversationUserId: issues.conversationUserId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, conversation.issueId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !issue ||
    !issue.conversationAgentId ||
    conversationChannel(issue) !== "telegram" ||
    conversationOwnerUserId(issue) !== input.userId
  ) {
    return denied(conversation.id);
  }

  // Claim the token before the write: a double tap must not apply twice.
  const [claimed] = await db
    .update(chatActions)
    .set({ status: "processing", principalId: input.principalId, updatedAt: new Date() })
    .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "issued")))
    .returning({ id: chatActions.id });
  if (!claimed) return { kind: "handled" };

  let picked: Awaited<ReturnType<typeof runBridgedChooserPick>>;
  try {
    picked = await runBridgedChooserPick({
      db,
      companyId: input.companyId,
      agentId: issue.conversationAgentId,
      conversationIssueId: issue.id,
      boardUserId: input.userId,
      commandName,
      value: pickValue,
      ...(input.commandSeams ?? {}),
    });
  } catch (error) {
    // Nothing is known to have been written: give the button back.
    await db
      .update(chatActions)
      .set({ status: "issued", updatedAt: new Date() })
      .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "processing")));
    throw error;
  }

  const applied = picked.outcome === "applied";
  try {
    await db.transaction(async (tx) => {
      await input.assertStillAuthorized(tx, conversation.id);
      // A refusal ("a reply is in progress") may be pressed again later, so it
      // does not use the one-shot idempotency key.
      await input.stageTaskControlPublication(tx as unknown as Db, {
        companyId: input.companyId,
        conversationId: conversation.id,
        endpointId: input.endpointId,
        idempotencyKey: applied
          ? `control:x8-${commandName}-pick:${token.id}`
          : `control:x8-${commandName}-pick-refused:${token.id}:${randomBytes(6).toString("hex")}`,
        issueId: issue.id,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "task_control",
          text: picked.text,
        }),
        principalId: input.principalId,
      });
      if (applied) {
        await tx
          .update(chatActions)
          .set({
            status: "processed",
            result: { code: "chooser_pick_applied", value: pickValue },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, token.id));
        // The list is answered: its other buttons are stale now.
        await tx
          .update(chatActions)
          .set({ status: "expired", result: { code: "chooser_list_answered" }, updatedAt: new Date() })
          .where(
            and(
              eq(chatActions.companyId, input.companyId),
              eq(chatActions.endpointId, input.endpointId),
              eq(chatActions.kind, CHOOSER_PICK_ACTION_KIND),
              eq(chatActions.status, "issued"),
              sql`${chatActions.payload}->>'publicationId' = ${publicationId}`,
            ),
          );
      } else {
        await tx
          .update(chatActions)
          .set({ status: "issued", updatedAt: new Date() })
          .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "processing")));
      }
    });
  } catch (error) {
    // The write itself may have happened; the person can press again, and the
    // command is idempotent (the same value is simply written again).
    await db
      .update(chatActions)
      .set({ status: "issued", updatedAt: new Date() })
      .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "processing")));
    throw error;
  }
  return { kind: "handled" };
}
