// server/src/myrmidon/channel-allowlist/refusal.ts
//
// myrmidon(CA-A): what happens to a message nobody admitted. The owner's
// rule (OPE-4949): an unadmitted writer is not served — the message does
// not execute, the writer sees ONE line without details, and the owner (or
// a designated admin, Part C) gets an access-request card they can approve
// with rights or deny. Provider-neutral: the chat layer calls this for any
// channel; Telegram is the first consumer.
//
// Dedupe mirrors the X8b refusal notice: `stageProviderEffect`'s unique
// `providerActionId` carries the UTC day, so a flood of refused messages
// costs the writer one line per day, and the card is idempotent on
// `channel-access:<provider>:<id>:<day>` inside `issuesSvc.create`.

import type { Db } from "@paperclipai/db";
import { CHANNEL_ALLOWLIST_REFUSAL_TEXT } from "@paperclipai/shared";
import type { ChatProvider } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import type { TelegramDmBridgeDeps } from "../agent-chat-bridge/bridge.js";
import { raiseChannelAccessRequest } from "./service.js";

/** The endpoint shape the stage path needs — the same row the caller holds. */
type StageEndpoint = Parameters<TelegramDmBridgeDeps["stageProviderEffect"]>[1]["endpoint"];
type StageThread = { id: string; isDirectMessage?: boolean; post: (...args: any[]) => any };

const MAX_LOGGED_ERROR_TEXT = 400;

/**
 * Same rule as the X8b bridge's local `redactTelegramDmError` (and the
 * vendor's private `redactError`): a Telegram Bot API failure can carry the
 * bot token in the request URL — the raw error must never reach the logs.
 */
function redactChannelError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const withoutTelegramBotTokens = text
    .replace(/(\/bot)\d{5,}(?::|%3A)[A-Za-z0-9_-]{20,}/gi, "$1***REDACTED***")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "***REDACTED***");
  return redactSensitiveText(withoutTelegramBotTokens).slice(0, MAX_LOGGED_ERROR_TEXT);
}

/**
 * Raises the owner's access-request card and sends the writer the one-line
 * refusal. Never throws: the caller is inside the filtered-delivery path,
 * and a board write or a provider post failing must not resurrect the
 * message or leak details. `sendNotice` lets the caller suppress the notice
 * where an older refusal path already answers the same sender (the X8b
 * bridged-DM notice) for the same delivery.
 */
export async function handleChannelAccessRefusal(
  db: Db,
  deps: Pick<TelegramDmBridgeDeps, "stageProviderEffect" | "processProviderEffect">,
  input: {
    companyId: string;
    endpoint: StageEndpoint;
    thread: StageThread;
    addressed: boolean;
    principalId: string;
    provider: ChatProvider;
    externalId: string;
    handle: string | null;
    displayName: string | null;
    deliveryId: string | null;
    resourceId: string;
    runtimeContext: { credentialFingerprint: string; generation: number };
    sendNotice: boolean;
    now?: Date;
  },
): Promise<{ requestId: string | null }> {
  let requestId: string | null = null;
  try {
    const raised = await raiseChannelAccessRequest(db, {
      companyId: input.companyId,
      endpointId: input.endpoint.id,
      provider: input.provider,
      externalId: input.externalId,
      handle: input.handle,
      displayName: input.displayName,
      now: input.now,
    });
    requestId = raised?.issueId ?? null;
  } catch (error) {
    // The card is a board write; failing it must not execute the message.
    logger.warn(
      { err: error, companyId: input.companyId },
      "myrmidon(CA-A): access-request card failed; the sender stays refused",
    );
  }
  // The writer's one line: only where the message actually reached for the
  // bot (a DM, or an addressed turn in a group), so a stranger shouting
  // into a channel never gets replies.
  if (input.sendNotice && (input.thread.isDirectMessage || input.addressed)) {
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    try {
      const effect = await deps.stageProviderEffect(db, {
        endpoint: input.endpoint,
        deliveryId: input.deliveryId,
        principalId: input.principalId,
        providerActionId: `provider_effect:ca-refusal:${input.endpoint.id}:${input.principalId}:${day}`,
        payload: {
          version: 1,
          authorizationMode: "safe_notice",
          effect: "thread_message",
          threadId: input.thread.id,
          text: CHANNEL_ALLOWLIST_REFUSAL_TEXT,
          settleDelivery: false,
          resourceId: input.resourceId,
        },
        runtimeContext: input.runtimeContext,
      });
      if (effect) await deps.processProviderEffect(effect.id, input.thread);
    } catch (error) {
      // Never log the raw error — see redactChannelError.
      logger.warn(
        { endpointId: input.endpoint.id, error: redactChannelError(error) },
        "myrmidon(CA-A): channel refusal notice failed",
      );
    }
  }
  return { requestId };
}

/**
 * The same refusal behind one outer guard: the chat layer calls this on a
 * path where nothing may throw back into delivery processing (the delivery
 * was already filtered — a failure here must leave the refusal standing,
 * not resurrect or crash the turn).
 */
export async function handleChannelAccessRefusalGuarded(
  db: Db,
  deps: Parameters<typeof handleChannelAccessRefusal>[1],
  input: Parameters<typeof handleChannelAccessRefusal>[2],
): Promise<{ requestId: string | null }> {
  try {
    return await handleChannelAccessRefusal(db, deps, input);
  } catch (error) {
    logger.warn(
      { err: error, companyId: input.companyId },
      "myrmidon(CA-A): refusal handling failed; the filtered delivery stays filtered",
    );
    return { requestId: null };
  }
}
