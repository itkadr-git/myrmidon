/**
 * X8 bridged direct-message command contract (agent-chat-bridge).
 *
 * A bridged Telegram direct message that starts with a `/command` is
 * intercepted before it reaches the agent, OpenClaw-style: `/help`, `/new`,
 * `/model`, `/think`, `/stop`, `/status`, plus the compatibility replies
 * `/close` and `/task`. X8a defined this module's shared shape
 * (`BridgedCommandInput`, `BridgedCommandResult`, `BridgedCommandSpec`,
 * `TELEGRAM_DM_COMMANDS`, `parseBridgedCommand`) with a minimal, only
 * `/new`/`/reset` stand-in body for `runBridgedDirectMessageCommand`; this
 * PR (X8c) keeps those signatures and replaces the body with the full
 * command set. X8b calls it.
 *
 * myrmidon(1.7-TG-LOCALE): every reply in this module is read by a person in
 * the bridged Telegram DM, so the prose renders from the locale catalogs
 * (../locales) in the linked board user's language — English is the default,
 * Russian is the pilot chat's language and the language a user gets after
 * selecting it on the board's Settings → Language screen (read per message,
 * no restart). The instance-wide `MYRMIDON_TELEGRAM_DM_LANGUAGE` env forces
 * one language for every chat, including the Telegram command menu. Command
 * names, model ids, reasoning levels and the `/model default` keyword stay as
 * they are — they are input, not prose.
 */

import type { Db } from "@paperclipai/db";
import { loadBridgedCommandContext, type BridgedCommandContext } from "./context.js";
import { t, resolveBridgeLocale, type BridgeLocale } from "../locales/index.js";
import { buildHelpText } from "./help.js";
// myrmidon(X9c): /agents, /to, /who — the X9a/X9b addressing surface as chat
// commands; sticky default routing state lives in agents.ts.
import {
  buildAgentsReplyText,
  buildWhoReplyText,
  handleToCommand,
  readStickyAgentId,
} from "./agents.js";
import {
  MODEL_CHOOSER,
  THINK_CHOOSER,
  checkChooserAvailability,
  describeCardValue,
  describeEffectiveChatValue,
  formatChatChoiceList,
  listedChatChoices,
  MAX_CHOICE_BUTTONS,
  wholeCatalogText,
  readOverrideAdapterConfig,
  resolveChatChoiceArgument,
  resolveChooserSelection,
  sourceLabelFor,
  turnInProgressText,
  unavailableChoiceText,
  type ChatModelCatalogReader,
  type ChatModelChooser,
} from "./models.js";
import { applyChatAdapterOverride, type ApplyChatAdapterOverrideInput, type ChatAdapterOverrideApplyDeps, type ChatAdapterOverrideBotApply } from "./overrides.js";
// myrmidon(F06-A): a gateway agent's `/model` choices live behind the gateway,
// not on its card — this is the read bound to that agent.
import { createGatewayModelCatalogReader } from "../gateway-model-catalog.js";
import { handlePlanCommand, isCompanyOwner } from "./plan.js";
import { buildChatStatusReply } from "./status.js";
import { stopBridgedChatRuns } from "./stop.js";
import { issueThreadInteractionService } from "../../../services/issue-thread-interactions.js";
import { issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

export interface BridgedCommandInput {
  db: Db;
  companyId: string;
  /** chat_endpoints.assigned_agent_id */
  agentId: string;
  endpointId: string;
  /** chat_deliveries.id of this message */
  deliveryId: string;
  /** Linked board user of the sender */
  boardUserId: string;
  /** The Telegram conversation issue; X8b guarantees it exists */
  conversationIssueId: string;
  /** Raw provider text */
  text: string;
  publicBaseUrl: string | null;
  cancelRun: (
    runId: string,
    reason: string,
    options: { errorCode?: string; resultJson?: Record<string, unknown> },
  ) => Promise<unknown>;
  /**
   * myrmidon(F06-A): test seams for the gateway command surface — the profile
   * apply of `/model` and `/think` on a gateway agent, and its model catalog.
   * Production leaves both unset: the apply goes through the bot-containers
   * runtime, and the catalog through this agent's own gateway key.
   */
  botContainerApply?: ChatAdapterOverrideApplyDeps;
  readGatewayModelCatalog?: ChatModelCatalogReader | null;
}

/**
 * myrmidon(F06-D): the choices of a `/model` or `/think` list as a menu — what
 * the bridge turns into inline buttons under the list and into the record that
 * lets a reply with a number or a name pick from it. `title` and `body` are the
 * card text (title = the current value line, body = the list); `options[].value`
 * is a candidate id or `default`, validated again on the click.
 */
export interface BridgedChoiceMenu {
  commandName: "model" | "think";
  title: string;
  body: string;
  options: Array<{ label: string; value: string }>;
}

export type BridgedCommandResult =
  | {
      kind: "reply";
      command: string;
      text: string;
      /** myrmidon(F06-D): set on a plain `/model` or `/think` list. */
      choices?: BridgedChoiceMenu;
      /** myrmidon(F06-D): `/model <x>` or `/think <x>` — whether the choice was
       *  written (`applied`) or refused (`refused`: unknown value, turn in
       *  progress, effort policy). Only chooser replies set it. */
      outcome?: "applied" | "refused";
    }
  | { kind: "message"; body: string; notice?: string }
  | null;

/**
 * myrmidon(F06-D): what a chooser command (and a button press / list reply that
 * stands for one) needs from its caller — a subset of the command input.
 */
export type BridgedChooserInput = Pick<
  BridgedCommandInput,
  "db" | "companyId" | "agentId" | "conversationIssueId" | "boardUserId" | "botContainerApply" | "readGatewayModelCatalog"
>;

/** myrmidon(F06-D): the test seams of the chooser commands (production leaves them unset). */
export type BridgedChooserSeams = Partial<
  Pick<BridgedCommandInput, "botContainerApply" | "readGatewayModelCatalog">
>;

export interface BridgedCommandSpec {
  command: string;
  description: string;
}

/**
 * The bridged DM's command menu rendered in one locale. Telegram shows one
 * menu per bot (X8e registers it for `all_private_chats`), so registration
 * follows the instance-level decision (the env force, else the English
 * default); the person's own language applies to every reply of the chat.
 */
export function telegramDmCommandsForLocale(locale: BridgeLocale): readonly BridgedCommandSpec[] {
  return [
    { command: "help", description: t(locale, "menu.help") },
    { command: "new", description: t(locale, "menu.new") },
    { command: "model", description: t(locale, "menu.model") },
    { command: "think", description: t(locale, "menu.think") },
    { command: "stop", description: t(locale, "menu.stop") },
    { command: "status", description: t(locale, "menu.status") },
    { command: "plan", description: t(locale, "menu.plan") },
    { command: "accept", description: t(locale, "menu.accept") },
    { command: "reject", description: t(locale, "menu.reject") },
    // myrmidon(X9c): addressing commands — which agent of the company this
    // chat talks to (X9a/X9b made any company agent addressable).
    { command: "agents", description: t(locale, "menu.agents") },
    { command: "to", description: t(locale, "menu.to") },
    { command: "who", description: t(locale, "menu.who") },
  ];
}

/**
 * The X8 contract's canonical command list, in the catalog's base language.
 * Tests and the copy-version hash compare against this list; the actual
 * registration applies the menu for the locale that holds when it runs
 * (same once-per-version rule as the bridge-enabled state — see DIVERGENCE
 * B1: a state that can flip back and forth is not baked into the version).
 */
export const TELEGRAM_DM_COMMANDS: readonly BridgedCommandSpec[] =
  telegramDmCommandsForLocale("en");

/**
 * myrmidon(X8c): `/start`, `/commands` and `/reset` are not part of the X8
 * contract's `TELEGRAM_DM_COMMANDS` (X8a canon), but OpenClaw's own DM
 * commands support them as compatibility aliases, so this bridge does too.
 */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  start: "help",
  commands: "help",
  reset: "new",
};

const BRIDGED_COMMAND_PATTERN = /^\/([a-z][\w-]*)(?:@[\w.]+)?(?:\s+([\s\S]*))?$/i;

/**
 * Parses a `/command[@bot] [args]` message. Returns null for anything that
 * is not a command, including a slash mid-path like `/home/x` (the name
 * must be followed by whitespace or the end of the string).
 */
export function parseBridgedCommand(text: string): { name: string; args: string } | null {
  const match = BRIDGED_COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * Longest command name echoed back in reply text (e.g. "Unknown command
 * /<name>."). `parsed.name` is untrusted chat input and BRIDGED_COMMAND_PATTERN
 * does not bound its length, so it is truncated before display. This is
 * separate from the `command` result field itself, which never carries
 * unvalidated chat input at all — see the two call sites below.
 */
const MAX_DISPLAYED_COMMAND_NAME_LENGTH = 64;

function truncateForDisplay(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export async function runBridgedDirectMessageCommand(
  input: BridgedCommandInput,
): Promise<BridgedCommandResult> {
  const parsed = parseBridgedCommand(input.text);
  if (!parsed) return null;
  const name = COMMAND_ALIASES[parsed.name] ?? parsed.name;

  // myrmidon(1.7-TG-LOCALE): the sender's language decides every reply of
  // this turn; resolved once so all branches answer in the same language.
  const locale = await resolveBridgeLocale(input.db, input.boardUserId);

  const context = await loadBridgedCommandContext(input.db, {
    companyId: input.companyId,
    agentId: input.agentId,
    boardUserId: input.boardUserId,
    conversationIssueId: input.conversationIssueId,
  });
  if (!context) {
    // myrmidon(X8c): `command` feeds the X8 contract's publication key
    // (`control:x8-${command}:${deliveryId}`, required to match `[a-z-]+`).
    // `name` is chat input at this point (COMMAND_ALIASES only rewrites
    // known names), so a fixed literal is used here instead of it.
    return { kind: "reply", command: "not-available", text: t(locale, "chat.notAvailable") };
  }

  switch (name) {
    case "help":
      return {
        kind: "reply",
        command: "help",
        text: buildHelpText(context.agent.name, telegramDmCommandsForLocale(locale), locale),
      };
    case "new":
      return handleNewCommand(input, context, parsed.args, locale);
    case "model":
      return handleChooserCommand(input, context, MODEL_CHOOSER, parsed.args, locale);
    case "think":
      return handleChooserCommand(input, context, THINK_CHOOSER, parsed.args, locale);
    case "stop":
      return handleStopCommand(input, locale);
    case "status":
      return handleStatusCommand(input, context, locale);
    case "plan":
      // myrmidon(1.6-CTO-CHAT-B): everything planner-shaped (settings read
      // per call, the company key, the plan id, the card) lives in
      // `./plan.ts`, which delegates to the cto-chat telegram entry — no
      // parallel secret-resolution path here.
      return handlePlanCommand(input, parsed.args);
    case "accept":
      return handleAcceptCommand(input, parsed.args, locale);
    case "reject":
      return handleRejectCommand(input, parsed.args, locale);
    // myrmidon(X9c): addressing commands. They run on the context X8b
    // already authorized (the sender's own bridged Telegram conversation,
    // identity links included), and every DB read in agents.ts is scoped to
    // input.companyId — only same-company agents can ever be listed,
    // resolved or made sticky. The sticky default routes the chat's plain
    // turns until the next /to (see agents.ts); addressed @<alias> turns
    // (X9b) are unaffected.
    case "agents": {
      const text = await buildAgentsReplyText(input.db, {
        companyId: input.companyId,
        conversationAgentId: input.agentId,
        stickyAgentId: readStickyAgentId(context.issue.assigneeAdapterOverrides),
        locale,
      });
      return { kind: "reply", command: "agents", text };
    }
    case "to": {
      const result = await handleToCommand({
        db: input.db,
        companyId: input.companyId,
        conversationAgentId: input.agentId,
        issueId: input.conversationIssueId,
        boardUserId: input.boardUserId,
        args: parsed.args,
        stickyAgentId: readStickyAgentId(context.issue.assigneeAdapterOverrides),
        locale,
      });
      return { kind: "reply", command: "to", text: result.text };
    }
    case "who": {
      const text = await buildWhoReplyText(input.db, {
        companyId: input.companyId,
        conversationAgentId: input.agentId,
        stickyAgentId: readStickyAgentId(context.issue.assigneeAdapterOverrides),
        locale,
      });
      return { kind: "reply", command: "who", text };
    }
    case "close":
      return { kind: "reply", command: "close", text: t(locale, "close.reply") };
    case "task":
      return { kind: "reply", command: "task", text: t(locale, "task.reply") };
    default:
      // myrmidon(X8c): same reasoning as the not-available branch above —
      // `name` is unvalidated chat input here, so `command` gets a fixed
      // literal; the original name is shown in `text` only, and truncated,
      // since BRIDGED_COMMAND_PATTERN does not bound its length.
      return {
        kind: "reply",
        command: "unknown",
        text: t(locale, "unknown.command", {
          name: truncateForDisplay(parsed.name, MAX_DISPLAYED_COMMAND_NAME_LENGTH),
        }),
      };
  }
}

/**
 * myrmidon(F06-A): the gateway model catalog for this chat's agent — the test
 * seam when one was given, else the real per-key read
 * (gateway-model-catalog.ts). Built per command, so the read happens only when
 * a chooser actually asks for it.
 */
function gatewayCatalogReader(
  input: BridgedChooserInput,
  agent: BridgedCommandContext["agent"],
): ChatModelCatalogReader {
  if (input.readGatewayModelCatalog) return input.readGatewayModelCatalog;
  return createGatewayModelCatalogReader({
    db: input.db,
    companyId: input.companyId,
    agentId: agent.id,
    agentSlug: agent.name,
    // myrmidon(F06-D): the key a bot really sends comes from its card.
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig,
  });
}

/**
 * myrmidon(F06-A): what to tell the person about the profile apply that
 * followed their choice. A gateway agent runs a bot container, which is only
 * as current as the last apply — so a success is worth one line, and a failure
 * (with the rollback it caused) must never pass silently.
 */
function botApplyNotice(
  botApply: ChatAdapterOverrideBotApply | undefined,
  locale: BridgeLocale,
): string | null {
  if (!botApply) return null;
  if (botApply.kind === "not_applicable") {
    return t(locale, "chooser.applyNotApplied", { reason: botApply.reason ?? botApply.kind });
  }
  if (botApply.kind !== "error") return t(locale, "chooser.applyNextTurn");
  const failure = t(locale, "chooser.applyFailed", { reason: botApply.reason ?? botApply.kind });
  return botApply.rolledBack ? `${failure}\n${t(locale, "chooser.applyRolledBack")}` : failure;
}

/** myrmidon(F06-A): the model this chat's effort would apply to (chat override
 *  first, then the card) — the effort policy check needs it. */
function effectiveChatModel(context: BridgedCommandContext): string | null {
  return describeEffectiveChatValue(
    readOverrideAdapterConfig(context.issue.assigneeAdapterOverrides),
    context.agent.adapterConfig,
    "model",
  ).value;
}

/** myrmidon(F06-A): the apply half of a chooser write, in one place, so no
 *  call site can quietly skip applying the profile of a gateway agent. */
function chatOverrideApplyInput(
  input: BridgedChooserInput,
  context: BridgedCommandContext,
): Pick<ApplyChatAdapterOverrideInput, "adapterType" | "adapterConfig" | "botApply"> {
  return {
    adapterType: context.agent.adapterType,
    adapterConfig: context.agent.adapterConfig,
    botApply: input.botContainerApply,
  };
}

async function handleNewCommand(
  input: BridgedCommandInput,
  context: BridgedCommandContext,
  args: string,
  locale: BridgeLocale,
): Promise<BridgedCommandResult> {
  const modelArg = args.trim();
  if (!modelArg) {
    return { kind: "message", body: "/new", notice: t(locale, "new.notice") };
  }

  const resolution = await resolveChooserSelection({
    chooser: MODEL_CHOOSER,
    agent: context.agent,
    arg: modelArg,
    turnInProgress: context.turnInProgress,
    // A model chosen with /new applies to the fresh session /new is about to
    // start, not to whatever is currently running; no need to wait for it.
    checkTurnInProgress: false,
    locale,
    // myrmidon(F06-A): a gateway agent's choices come from the gateway catalog.
    catalog: gatewayCatalogReader(input, context.agent),
  });
  if (resolution.kind === "error") {
    return { kind: "reply", command: "new", text: resolution.text };
  }

  const value = resolution.kind === "default" ? null : resolution.candidate.id;
  const overrideResult = await applyChatAdapterOverride({
    db: input.db,
    companyId: input.companyId,
    conversationAgentId: input.agentId,
    issueId: input.conversationIssueId,
    boardUserId: input.boardUserId,
    key: MODEL_CHOOSER.adapterConfigKey,
    value,
    // A model chosen with /new applies to the fresh session it is about to
    // start regardless of what is currently running — same reasoning as
    // `checkTurnInProgress: false` above.
    refuseIfTurnInProgress: false,
    ...chatOverrideApplyInput(input, context),
  });
  const modelLabel =
    resolution.kind === "default"
      ? t(locale, "chooser.agentDefaultParen", {
          value:
            describeCardValue(context.agent.adapterConfig, MODEL_CHOOSER.adapterConfigKey) ??
            t(locale, "source.adapterDefault"),
        })
      : resolution.candidate.id;
  const applyNotice = botApplyNotice(overrideResult.botApply, locale);
  return {
    kind: "message",
    body: "/new",
    notice:
      t(locale, "new.withModel.notice", { model: modelLabel }) +
      (applyNotice ? `\n${applyNotice}` : ""),
  };
}

async function handleChooserCommand(
  input: BridgedChooserInput,
  context: BridgedCommandContext,
  chooser: ChatModelChooser,
  args: string,
  locale: BridgeLocale,
): Promise<BridgedCommandResult> {
  const overrideAdapterConfig = readOverrideAdapterConfig(context.issue.assigneeAdapterOverrides);
  const trimmed = args.trim();
  const statusLabel = t(locale, chooser.statusLabelKey);

  if (!trimmed) {
    // myrmidon(F06-A): a gateway agent's choices come from the gateway catalog.
    const availability = await checkChooserAvailability(
      chooser,
      context.agent,
      gatewayCatalogReader(input, context.agent),
    );
    if (!availability.available) {
      return {
        kind: "reply",
        command: chooser.commandName,
        text: unavailableChoiceText(
          chooser,
          context.agent,
          locale,
          availability.reasonKey ?? "chooser.reason.unsupportedAdapter",
        ),
      };
    }
    const effective = describeEffectiveChatValue(
      overrideAdapterConfig,
      context.agent.adapterConfig,
      chooser.adapterConfigKey,
    );
    const sourceText = sourceLabelFor(effective.source, locale);
    const effectiveLine = t(locale, "chooser.effective", {
      label: statusLabel,
      value: effective.value ?? sourceText,
      source: sourceText,
    });
    const listBody =
      t(locale, "chooser.availableHeader") +
      "\n" +
      formatChatChoiceList(availability.candidates, locale) +
      "\n" +
      // The list is complete; only the keyboard is capped (MAX_CHOICE_BUTTONS).
      (availability.candidates.length > MAX_CHOICE_BUTTONS
        ? `${t(locale, "chooser.moreHidden", { count: MAX_CHOICE_BUTTONS })}\n`
        : "") +
      // myrmidon(F06-A): the per-key read failed and this is the whole
      // gateway catalog — the person has to know the list is a superset.
      // myrmidon(F06-D): and why the agent's own list was not used.
      (availability.wholeCatalog ? `${wholeCatalogText(locale, availability.keyFailure)}\n` : "") +
      t(locale, "chooser.usage", { command: chooser.commandName });
    return {
      kind: "reply",
      command: chooser.commandName,
      text: `${effectiveLine}\n${listBody}`,
      choices: {
        commandName: chooser.commandName,
        title: effectiveLine,
        body: listBody,
        options: [
          ...listedChatChoices(availability.candidates).map((candidate) => ({
            // The current value is marked on its button; the value stays the bare id.
            label: candidate.id === effective.value ? `✓ ${candidate.label}` : candidate.label,
            value: candidate.id,
          })),
          { label: t(locale, "chooser.button.default"), value: "default" },
        ],
      },
    };
  }

  const resolution = await resolveChooserSelection({
    chooser,
    agent: context.agent,
    arg: trimmed,
    turnInProgress: context.turnInProgress,
    checkTurnInProgress: true,
    locale,
    // myrmidon(F06-A): the gateway catalog for the list, and the model this
    // chat would run for /think's effort policy check.
    catalog: gatewayCatalogReader(input, context.agent),
    effectiveModel: effectiveChatModel(context),
  });
  if (resolution.kind === "error") {
    return { kind: "reply", command: chooser.commandName, text: resolution.text, outcome: "refused" };
  }

  if (resolution.kind === "default") {
    const overrideResult = await applyChatAdapterOverride({
      db: input.db,
      companyId: input.companyId,
      conversationAgentId: input.agentId,
      issueId: input.conversationIssueId,
      boardUserId: input.boardUserId,
      key: chooser.adapterConfigKey,
      value: null,
      // myrmidon(X8c): re-checked at write time (see overrides.ts) — a reply
      // can start in the gap between resolveChooserSelection's read above and
      // this write.
      refuseIfTurnInProgress: true,
      ...chatOverrideApplyInput(input, context),
    });
    if (!overrideResult.applied) {
      return { kind: "reply", command: chooser.commandName, text: turnInProgressText(locale), outcome: "refused" };
    }
    const applyNotice = botApplyNotice(overrideResult.botApply, locale);
    return {
      kind: "reply",
      command: chooser.commandName,
      outcome: "applied",
      text:
        t(locale, "chooser.defaultApplied", {
          label: statusLabel,
          agentDefault: t(locale, "chooser.agentDefaultParen", {
            value:
              describeCardValue(context.agent.adapterConfig, chooser.adapterConfigKey) ??
              t(locale, "source.adapterDefault"),
          }),
        }) + (applyNotice ? `\n${applyNotice}` : ""),
    };
  }

  const overrideResult = await applyChatAdapterOverride({
    db: input.db,
    companyId: input.companyId,
    conversationAgentId: input.agentId,
    issueId: input.conversationIssueId,
    boardUserId: input.boardUserId,
    key: chooser.adapterConfigKey,
    value: resolution.candidate.id,
    refuseIfTurnInProgress: true,
    ...chatOverrideApplyInput(input, context),
  });
  if (!overrideResult.applied) {
    return { kind: "reply", command: chooser.commandName, text: turnInProgressText(locale), outcome: "refused" };
  }
  const applyNotice = botApplyNotice(overrideResult.botApply, locale);
  return {
    kind: "reply",
    command: chooser.commandName,
    outcome: "applied",
    text:
      t(locale, "chooser.set", { label: statusLabel, value: resolution.candidate.id }) +
      (applyNotice ? `\n${applyNotice}` : ""),
  };
}

/**
 * myrmidon(F06-D): a button press under a `/model` or `/think` list. Runs the
 * same path as `/model <value>`: the value is resolved against the live
 * candidates again, the turn-in-progress and effort-policy refusals apply, and
 * a gateway agent's profile is applied. The caller (the chat action handler)
 * has already proven the press comes from this conversation's own linked
 * person on the list message; this checks the conversation again.
 */
export async function runBridgedChooserPick(
  input: BridgedChooserInput & { commandName: "model" | "think"; value: string },
): Promise<{ text: string; outcome: "applied" | "refused" }> {
  const locale = await resolveBridgeLocale(input.db, input.boardUserId);
  const context = await loadBridgedCommandContext(input.db, {
    companyId: input.companyId,
    agentId: input.agentId,
    boardUserId: input.boardUserId,
    conversationIssueId: input.conversationIssueId,
  });
  if (!context) return { text: t(locale, "chat.notAvailable"), outcome: "refused" };
  const chooser = input.commandName === "model" ? MODEL_CHOOSER : THINK_CHOOSER;
  const result = await handleChooserCommand(input, context, chooser, input.value, locale);
  if (result?.kind !== "reply") return { text: t(locale, "chat.notAvailable"), outcome: "refused" };
  return { text: result.text, outcome: result.outcome ?? "refused" };
}

/**
 * myrmidon(F06-D): a plain reply to a `/model` or `/think` list. A whole number
 * or a name that resolves among that list's choices (or `default`) picks it,
 * exactly like `/model <text>`. Anything else — an ordinary sentence that
 * happens to be a reply to the list message — is not a choice: null, and the
 * message goes to the agent as usual.
 */
export async function runBridgedChooserReply(
  input: BridgedChooserInput & { commandName: "model" | "think"; text: string },
): Promise<BridgedCommandResult> {
  const arg = input.text.trim();
  if (!arg || arg.length > 200 || arg.includes("\n")) return null;
  const locale = await resolveBridgeLocale(input.db, input.boardUserId);
  const context = await loadBridgedCommandContext(input.db, {
    companyId: input.companyId,
    agentId: input.agentId,
    boardUserId: input.boardUserId,
    conversationIssueId: input.conversationIssueId,
  });
  if (!context) return null;
  const chooser = input.commandName === "model" ? MODEL_CHOOSER : THINK_CHOOSER;
  const availability = await checkChooserAvailability(
    chooser,
    context.agent,
    gatewayCatalogReader(input, context.agent),
  );
  if (!availability.available) return null;
  const isNumber = /^\d+$/.test(arg);
  const isDefault = arg.toLowerCase() === "default";
  if (!isNumber && !isDefault && !resolveChatChoiceArgument(availability.candidates, arg)) return null;
  return handleChooserCommand(input, context, chooser, arg, locale);
}

async function handleStopCommand(
  input: BridgedCommandInput,
  locale: BridgeLocale,
): Promise<BridgedCommandResult> {
  const result = await stopBridgedChatRuns({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.conversationIssueId,
    boardUserId: input.boardUserId,
    cancelRun: input.cancelRun,
  });
  const text = result.failed
    ? t(locale, "stop.unavailable")
    : result.stopped > 0
      ? t(locale, "stop.stopping")
      : t(locale, "stop.idle");
  return { kind: "reply", command: "stop", text };
}

async function handleStatusCommand(
  input: BridgedCommandInput,
  context: BridgedCommandContext,
  locale: BridgeLocale,
): Promise<BridgedCommandResult> {
  const text = await buildChatStatusReply({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    boardUserId: input.boardUserId,
    publicBaseUrl: input.publicBaseUrl,
    context,
    locale,
  });
  return { kind: "reply", command: "status", text };
}

/**
 * myrmidon(1.6.3-CTO-CHAT-B): `/accept <id>` approves a pending
 * `suggest_tasks` plan card from the owner's own bridged Telegram DM,
 * through the same board service the portal accept route uses. Owner only,
 * like `/plan`: the bridged chat identity alone is not enough to create work.
 * The reply carries the link to the plan's root epic and the created count.
 */
async function handleAcceptCommand(
  input: BridgedCommandInput,
  args: string,
  locale: BridgeLocale,
): Promise<BridgedCommandResult> {
  const interactionId = args.trim();
  if (!interactionId) {
    return { kind: "reply", command: "accept", text: t(locale, "accept.noId") };
  }
  if (!(await isCompanyOwner(input.db, input.companyId, input.boardUserId))) {
    return { kind: "reply", command: "accept", text: t(locale, "accept.notOwner") };
  }

  const service = issueThreadInteractionService(input.db);
  try {
    const issue = await loadConversationHost(input);
    const current = await service.getForIssue(
      { id: issue.id, companyId: issue.companyId },
      interactionId,
    );
    if (current.kind !== "suggest_tasks" || current.status !== "pending") {
      return { kind: "reply", command: "accept", text: t(locale, "accept.notPlanOrProcessed") };
    }

    const allClientKeys = current.payload.tasks.map((task: { clientKey: string }) => task.clientKey);
    const accepted = await service.acceptInteraction(
      issue,
      interactionId,
      { selectedClientKeys: allClientKeys },
      {
        userId: input.boardUserId,
        agentId: null,
        suggestedTaskEffectsAuthorized: true,
        conversationRootTasksAllowed: true,
      },
    );

    // The link points at the plan's root (the draft without a parent), not at
    // whichever issue happened to be created first.
    const rootKey =
      current.payload.tasks.find((task: { parentClientKey?: string | null }) => !task.parentClientKey)?.clientKey ??
      null;
    const createdTasks =
      ((accepted.interaction.result as unknown as { createdTasks?: Array<{ clientKey: string; issueId: string; identifier: string | null }> } | null)
        ?.createdTasks) ?? [];
    const root = createdTasks.find((task) => task.clientKey === rootKey) ?? createdTasks[0] ?? null;
    const base = (input.publicBaseUrl ?? "").replace(/\/+$/, "");
    const epicLink = root ? (base ? `${base}/issues/${root.issueId}` : (root.identifier ?? root.issueId)) : "-";
    return {
      kind: "reply",
      command: "accept",
      text: t(locale, "accept.ok", { epicLink, count: accepted.createdIssues.length }),
    };
  } catch (error) {
    const message = (error as { message?: string }).message ?? "unknown error";
    return { kind: "reply", command: "accept", text: t(locale, "accept.error", { message }) };
  }
}

/**
 * myrmidon(1.6.3-CTO-CHAT-B): `/reject <id>` rejects a pending
 * `suggest_tasks` plan card from the owner's own bridged Telegram DM,
 * through the same board service as the portal reject route (owner only).
 * No tasks are created; the card closes as rejected.
 */
async function handleRejectCommand(
  input: BridgedCommandInput,
  args: string,
  locale: BridgeLocale,
): Promise<BridgedCommandResult> {
  const interactionId = args.trim();
  if (!interactionId) {
    return { kind: "reply", command: "reject", text: t(locale, "reject.noId") };
  }
  if (!(await isCompanyOwner(input.db, input.companyId, input.boardUserId))) {
    return { kind: "reply", command: "reject", text: t(locale, "reject.notOwner") };
  }

  const service = issueThreadInteractionService(input.db);
  try {
    const issue = await loadConversationHost(input);
    const current = await service.getForIssue(
      { id: issue.id, companyId: issue.companyId },
      interactionId,
    );
    if (current.status !== "pending") {
      return { kind: "reply", command: "reject", text: t(locale, "reject.alreadyProcessed") };
    }
    if (current.kind !== "suggest_tasks") {
      return { kind: "reply", command: "reject", text: t(locale, "reject.notPlan") };
    }
    await service.rejectInteraction(
      issue,
      interactionId,
      { reason: "rejected_by_owner_via_telegram" },
      { userId: input.boardUserId, agentId: null },
    );
    return { kind: "reply", command: "reject", text: t(locale, "reject.ok") };
  } catch (error) {
    const message = (error as { message?: string }).message ?? "unknown error";
    return { kind: "reply", command: "reject", text: t(locale, "reject.error", { message }) };
  }
}

/** The standing conversation issue with its real project/goal (children inherit them). */
async function loadConversationHost(input: BridgedCommandInput) {
  const [row] = await input.db
    .select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId, goalId: issues.goalId })
    .from(issues)
    .where(and(eq(issues.id, input.conversationIssueId), eq(issues.companyId, input.companyId)));
  if (!row) throw new Error("conversation issue not found");
  return row;
}
