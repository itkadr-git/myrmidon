// myrmidon(X8c): applies a /model or /think choice as a per-chat override on
// assignee_adapter_overrides.adapterConfig, and drops the provider session so
// the next reply picks it up (design doc fact F11: a model/effort change
// resets the provider session; the replay that follows needs the session
// gone, exactly like /new's own reset in agent-conversations.ts).

// myrmidon(F06-A): a gateway agent runs a bot container, and its model/effort
// come from the agent profile (profile-compiler.ts writes them into the
// container's config.yaml). Writing the chat override alone would leave the
// running container on the old profile, so a gateway write is followed by an
// apply without a restart — and rolled back if that apply fails.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, issues } from "@paperclipai/db";
import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
} from "../../../services/activity-log.js";
import { applyBotContainerNow, type ApplyBotContainerOutcome, type BotContainerAgent } from "../../bot-containers/index.js";
import { getBotContainerRuntime } from "../../bot-containers/routes-wiring.js";
import { isBridgedCommandTurnInProgress } from "./context.js";
import { GATEWAY_ADAPTER_TYPES, isRecord } from "./models.js";
import { cardUsesLlmGateway } from "../../bot-containers/profile-input.js";

/** myrmidon(F06-A): reported when no bot-containers runtime is wired in this
 *  process (the feature is off) — an unapplied write, not a failure. */
const NO_RUNTIME_REASON = "the bot-containers runtime is not available in this process";

/** myrmidon(F06-D): the provider a chat override writes next to a gateway model. */
export const CHAT_OVERRIDE_GATEWAY_PROVIDER = "custom";

/**
 * myrmidon(F06-D): the run sends the card's `provider` together with the model
 * (hermes gateway adapter, buildRunBody). Every `/model` candidate is a gateway
 * catalog id, so a card that names a native provider (`anthropic`, ...) and a
 * chosen model from the gateway would reach the run as a mismatched pair. The
 * chosen model decides the route: a model the card itself carries keeps the
 * card's provider; any other gateway model is run through the gateway
 * (`custom`). A card that already goes through the gateway needs no override.
 * Returns the provider to write into the chat override, or null for none.
 */
export function providerOverrideForModel(card: Record<string, unknown>, model: string | null): string | null {
  if (!model) return null;
  if (cardUsesLlmGateway(card)) return null;
  const models = isRecord(card.models) ? card.models : {};
  const own = new Set<string>();
  if (typeof card.model === "string") own.add(card.model.trim());
  if (Array.isArray(models.fallbacks)) {
    for (const entry of models.fallbacks) if (typeof entry === "string") own.add(entry.trim());
  }
  return own.has(model.trim()) ? null : CHAT_OVERRIDE_GATEWAY_PROVIDER;
}

export interface ApplyChatAdapterOverrideInput {
  db: Db;
  companyId: string;
  /** The conversation's agent (== issue.conversationAgentId, checked by the caller). */
  conversationAgentId: string;
  issueId: string;
  boardUserId: string;
  key: "model" | "effort";
  /** The new value, or null to clear the override back to the agent card. */
  value: string | null;
  /**
   * `/model` and `/think` must not apply while a reply is in progress; `/new`
   * applies regardless (design doc: a model chosen with `/new` targets the
   * fresh session it is about to start, not whatever is currently running).
   * When true, this is re-checked here, inside the row lock below, against a
   * freshly read `executionRunId` — the caller's own check (loadBridgedCommandContext,
   * argument resolution) ran earlier and against a value that can be stale by
   * the time this write happens.
   */
  refuseIfTurnInProgress: boolean;
  /**
   * myrmidon(F06-A): the agent's adapter type. A gateway adapter gets its
   * written value applied to the container profile (`botApply` below); every
   * other adapter just gets the override, exactly as before.
   */
  adapterType?: string;
  /**
   * myrmidon(F06-A): the agent card's adapterConfig, handed to the apply — a
   * runtime without its own agent read (see botContainerAgentReader) falls back
   * to it.
   */
  adapterConfig?: Record<string, unknown>;
  /** myrmidon(F06-A): the profile-apply hook, see ChatAdapterOverrideApplyDeps. */
  botApply?: ChatAdapterOverrideApplyDeps;
}

/**
 * myrmidon(F06-A): how a written override is made to take effect on a gateway
 * agent's bot container. Production reads the bot-containers runtime and
 * applies the agent profile now (the same call the access-hub rotation makes,
 * `force: true`); tests inject an outcome, or null for "no runtime".
 */
export interface ChatAdapterOverrideApplyDeps {
  /** null = there is no runtime to apply to: the outcome is not_applicable and
   *  the written value stays for the container's own next pass. */
  apply: (agent: BotContainerAgent) => Promise<ApplyBotContainerOutcome | null>;
}

/** myrmidon(F06-A): the profile-apply outcome as the caller reports it. */
export interface ChatAdapterOverrideBotApply {
  kind: ApplyBotContainerOutcome["kind"];
  reason: string | null;
  /** True when the write was put back after a failed apply. */
  rolledBack: boolean;
}

export interface ChatAdapterOverrideResult {
  applied: boolean;
  /** myrmidon(F06-A): set when a gateway agent's profile was applied — or could
   *  not be. Absent for every other adapter. */
  botApply?: ChatAdapterOverrideBotApply;
}

/** myrmidon(F06-A): the production hook — the profile apply through the
 *  bot-containers wiring. */
function defaultBotContainerApply(): ChatAdapterOverrideApplyDeps["apply"] {
  return async (agent) => {
    const runtime = getBotContainerRuntime();
    if (!runtime) return null;
    return applyBotContainerNow(agent, runtime, { force: true });
  };
}

/** myrmidon(F06-A): the value this chat had for `key` before the write (null = unset). */
function readOverrideProvider(adapterConfig: Record<string, unknown>): string | null {
  const value = adapterConfig.provider;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOverrideValue(adapterConfig: Record<string, unknown>, key: "model" | "effort"): string | null {
  const value = adapterConfig[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** myrmidon(F06-A): the human-readable reason of an apply outcome — the
 *  reconcile kinds carry `message` when they fail, the not-applicable kind
 *  carries `reason`. */
function outcomeReason(outcome: ApplyBotContainerOutcome): string | null {
  if ("reason" in outcome && typeof outcome.reason === "string") return outcome.reason;
  if ("message" in outcome && typeof outcome.message === "string") return outcome.message;
  return null;
}

/**
 * Merges `{ key: value }` into this conversation's `adapterConfig` override
 * (dropping the key entirely when `value` is null), keeping other override
 * keys as-is, then deletes this conversation's provider session so the next
 * reply starts fresh with a replay of recent history.
 *
 * Returns `{ applied: false }` without writing anything when the issue is
 * gone, or when `refuseIfTurnInProgress` is true and a reply turns out to
 * already be queued or running for this conversation.
 */
export async function applyChatAdapterOverride(
  input: ApplyChatAdapterOverrideInput,
): Promise<ChatAdapterOverrideResult> {
  let publication: ActivityPublication | null = null;
  let applied = false;
  let previousValue: string | null = null;
  let previousProvider: string | null | undefined;
  await input.db.transaction(async (tx) => {
    const [issue] = await tx
      .select({
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update");
    if (!issue) return;

    if (input.refuseIfTurnInProgress) {
      const turnInProgress = await isBridgedCommandTurnInProgress(tx as unknown as Db, {
        companyId: input.companyId,
        agentId: input.conversationAgentId,
        issueId: input.issueId,
        executionRunId: issue.executionRunId,
      });
      if (turnInProgress) return;
    }

    const overrides: Record<string, unknown> = isRecord(issue.assigneeAdapterOverrides)
      ? issue.assigneeAdapterOverrides
      : {};
    const adapterConfig: Record<string, unknown> = {
      ...(isRecord(overrides.adapterConfig) ? overrides.adapterConfig : {}),
    };
    previousValue = readOverrideValue(adapterConfig, input.key);
    if (input.value === null) {
      delete adapterConfig[input.key];
    } else {
      adapterConfig[input.key] = input.value;
    }
    // myrmidon(F06-D): the provider of the pair follows the chosen model (see
    // providerOverrideForModel). Only when the card is known: without it the
    // override is left exactly as before.
    if (input.key === "model" && input.adapterConfig && GATEWAY_ADAPTER_TYPES.includes(input.adapterType ?? "")) {
      previousProvider = readOverrideProvider(adapterConfig);
      const provider = providerOverrideForModel(input.adapterConfig, input.value);
      if (provider) adapterConfig.provider = provider;
      else delete adapterConfig.provider;
    }

    const nextOverrides: Record<string, unknown> = { ...overrides };
    if (Object.keys(adapterConfig).length > 0) {
      nextOverrides.adapterConfig = adapterConfig;
    } else {
      delete nextOverrides.adapterConfig;
    }

    await tx
      .update(issues)
      .set({
        assigneeAdapterOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.issueId));

    // Deliberately does not touch sessions belonging to other tasks (same
    // scope as /new's own delete in agent-conversations.ts:191-199).
    await tx
      .delete(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, input.companyId),
          eq(agentTaskSessions.agentId, input.conversationAgentId),
          eq(agentTaskSessions.taskKey, input.issueId),
        ),
      );

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
          conversationOverride: { key: input.key, value: input.value },
        },
      })
    ).publication;
    applied = true;
  });
  if (publication) publishActivity(publication);
  if (!applied) return { applied: false };
  if (!GATEWAY_ADAPTER_TYPES.includes(input.adapterType ?? "")) return { applied: true };

  // myrmidon(F06-A): the value is in the chat's override, but a gateway agent
  // runs a bot container off its compiled profile — apply that profile now so
  // the change needs no restart. A failed apply is not silently kept: the
  // override goes back to what it was, and the caller reports both.
  const apply = input.botApply?.apply ?? defaultBotContainerApply();
  let outcome: ApplyBotContainerOutcome | null = null;
  try {
    outcome = await apply({
      agentId: input.conversationAgentId,
      adapterType: input.adapterType ?? "",
      adapterConfig: input.adapterConfig ?? {},
    });
  } catch (error) {
    outcome = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  if (outcome === null) {
    return { applied: true, botApply: { kind: "not_applicable", reason: NO_RUNTIME_REASON, rolledBack: false } };
  }
  const reason = outcomeReason(outcome);
  if (outcome.kind !== "error") {
    return { applied: true, botApply: { kind: outcome.kind, reason, rolledBack: false } };
  }
  const rolledBack = await restoreChatAdapterOverrideKey({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issueId,
    key: input.key,
    value: previousValue,
    provider: previousProvider,
  });
  return { applied: true, botApply: { kind: "error", reason, rolledBack } };
}

/**
 * myrmidon(F06-A): puts this chat's `key` back to `value` (null = the key is
 * dropped) after a failed profile apply, in its own transaction — the write
 * itself already committed, so the undo cannot be part of it. The provider
 * session that write dropped stays dropped: the next reply starts a fresh
 * session with the same replayed history, so this costs a session, not
 * correctness.
 */
async function restoreChatAdapterOverrideKey(input: {
  db: Db;
  companyId: string;
  issueId: string;
  key: "model" | "effort";
  value: string | null;
  /** The chat override's provider before the write; undefined = it was not touched. */
  provider?: string | null;
}): Promise<boolean> {
  return input.db.transaction(async (tx) => {
    const [issue] = await tx
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update");
    if (!issue) return false;

    const overrides: Record<string, unknown> = isRecord(issue.assigneeAdapterOverrides)
      ? issue.assigneeAdapterOverrides
      : {};
    const adapterConfig: Record<string, unknown> = {
      ...(isRecord(overrides.adapterConfig) ? overrides.adapterConfig : {}),
    };
    if (input.value === null) {
      delete adapterConfig[input.key];
    } else {
      adapterConfig[input.key] = input.value;
    }
    if (input.provider !== undefined) {
      if (input.provider === null) delete adapterConfig.provider;
      else adapterConfig.provider = input.provider;
    }
    const nextOverrides: Record<string, unknown> = { ...overrides };
    if (Object.keys(adapterConfig).length > 0) {
      nextOverrides.adapterConfig = adapterConfig;
    } else {
      delete nextOverrides.adapterConfig;
    }

    await tx
      .update(issues)
      .set({
        assigneeAdapterOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.issueId));
    return true;
  });
}
