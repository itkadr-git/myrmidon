/**
 * X8 bridged direct-message command contract (agent-chat-bridge).
 *
 * myrmidon(1.6.6 CH-CONNECTOR-D) batch 3 (OPE-6976, call map OPE-6629 points
 * 71-72): the direct path is deprecated. The core reaches the command menu
 * through the bridge seams `channel-connectors/bridge/commands.js` and
 * `channel-connectors/bridge/locales.js` only; with the bridge flag on a
 * registered channel connector serves the theme and this module stays behind
 * the seam as the legacy fallback. The canonical list `TELEGRAM_DM_COMMANDS`
 * is contract data: it stays on this module's value even through the seam (see
 * the seam's note). Do not add a new direct importer; removal is the follow-up
 * step, not this PR.
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
  readOverrideAdapterConfig,
  resolveChooserSelection,
  sourceLabelFor,
  turnInProgressText,
  type ChatModelChooser,
} from "./models.js";
import { applyChatAdapterOverride } from "./overrides.js";
import { handlePlanCommand } from "./plan.js";
import { buildChatStatusReply } from "./status.js";
import { stopBridgedChatRuns } from "./stop.js";

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
}

export type BridgedCommandResult =
  | { kind: "reply"; command: string; text: string }
  | { kind: "message"; body: string; notice?: string }
  | null;

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
  });
  if (resolution.kind === "error") {
    return { kind: "reply", command: "new", text: resolution.text };
  }

  const value = resolution.kind === "default" ? null : resolution.candidate.id;
  await applyChatAdapterOverride({
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
  });
  const modelLabel =
    resolution.kind === "default"
      ? t(locale, "chooser.agentDefaultParen", {
          value:
            describeCardValue(context.agent.adapterConfig, MODEL_CHOOSER.adapterConfigKey) ??
            t(locale, "source.adapterDefault"),
        })
      : resolution.candidate.id;
  return {
    kind: "message",
    body: "/new",
    notice: t(locale, "new.withModel.notice", { model: modelLabel }),
  };
}

async function handleChooserCommand(
  input: BridgedCommandInput,
  context: BridgedCommandContext,
  chooser: ChatModelChooser,
  args: string,
  locale: BridgeLocale,
): Promise<BridgedCommandResult> {
  const overrideAdapterConfig = readOverrideAdapterConfig(context.issue.assigneeAdapterOverrides);
  const trimmed = args.trim();
  const statusLabel = t(locale, chooser.statusLabelKey);

  if (!trimmed) {
    const availability = await checkChooserAvailability(chooser, context.agent);
    if (!availability.available) {
      return {
        kind: "reply",
        command: chooser.commandName,
        text: t(locale, chooser.unavailableTextKey),
      };
    }
    const effective = describeEffectiveChatValue(
      overrideAdapterConfig,
      context.agent.adapterConfig,
      chooser.adapterConfigKey,
    );
    const sourceText = sourceLabelFor(effective.source, locale);
    return {
      kind: "reply",
      command: chooser.commandName,
      text:
        t(locale, "chooser.effective", {
          label: statusLabel,
          value: effective.value ?? sourceText,
          source: sourceText,
        }) +
        "\n" +
        t(locale, "chooser.availableHeader") +
        "\n" +
        formatChatChoiceList(availability.candidates) +
        "\n" +
        t(locale, "chooser.usage", { command: chooser.commandName }),
    };
  }

  const resolution = await resolveChooserSelection({
    chooser,
    agent: context.agent,
    arg: trimmed,
    turnInProgress: context.turnInProgress,
    checkTurnInProgress: true,
    locale,
  });
  if (resolution.kind === "error") {
    return { kind: "reply", command: chooser.commandName, text: resolution.text };
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
    });
    if (!overrideResult.applied) {
      return { kind: "reply", command: chooser.commandName, text: turnInProgressText(locale) };
    }
    return {
      kind: "reply",
      command: chooser.commandName,
      text: t(locale, "chooser.defaultApplied", {
        label: statusLabel,
        agentDefault: t(locale, "chooser.agentDefaultParen", {
          value:
            describeCardValue(context.agent.adapterConfig, chooser.adapterConfigKey) ??
            t(locale, "source.adapterDefault"),
        }),
      }),
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
  });
  if (!overrideResult.applied) {
    return { kind: "reply", command: chooser.commandName, text: turnInProgressText(locale) };
  }
  return {
    kind: "reply",
    command: chooser.commandName,
    text: t(locale, "chooser.set", { label: statusLabel, value: resolution.candidate.id }),
  };
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
