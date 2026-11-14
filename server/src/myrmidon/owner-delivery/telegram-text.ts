import type {
  AskUserQuestionsInteraction,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
} from "@myrmidon/shared";
import { projectSafeChatPublicationText } from "../../services/chat-publication-projection.js";
import { t, type BridgeLocale } from "../agent-chat-bridge/locales/index.js";

const MAX_TELEGRAM_MESSAGE_LENGTH = 4_096;

const QUESTION_REPLY_GUIDANCE_KEY = "owner.questionReplyGuidance" as const;

/** The complete owner text does not fit into one Telegram message. */
export class TelegramOwnerTextTooLongError extends Error {
  constructor(readonly length: number) {
    super(
      `Owner interaction text exceeds Telegram's ${MAX_TELEGRAM_MESSAGE_LENGTH}-character message limit`,
    );
    this.name = "TelegramOwnerTextTooLongError";
  }
}

function finishTelegramText(lines: string[]): string {
  const text = projectSafeChatPublicationText(lines.join("\n").trim());
  if (text.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
    throw new TelegramOwnerTextTooLongError(text.length);
  }
  return text;
}

/**
 * Short notice for an interaction that cannot be shown in Telegram (too long,
 * or a tool/secret/connection confirmation that is resolved on the board
 * only). Carries no interaction content, so it always fits.
 */
export function telegramOwnerBoardOnlyText(
  locale: BridgeLocale,
  taskUrl: string | null,
  reason: "too_long" | "board_only",
): string {
  const lines = [
    reason === "too_long"
      ? t(locale, "owner.tooLongForTelegram")
      : t(locale, "owner.needsYourDecision"),
    t(locale, "owner.boardOnlyReply"),
  ];
  if (taskUrl) lines.push("", taskUrl);
  return finishTelegramText(lines);
}

export function telegramOwnerQuestionText(
  locale: BridgeLocale,
  interaction: AskUserQuestionsInteraction,
  taskUrl: string | null,
): string {
  const questionSet = interaction.payload.questionSet;
  const lines = [
    questionSet?.title?.trim() ||
      interaction.payload.title?.trim() ||
      interaction.title?.trim() ||
      t(locale, "owner.defaultQuestionTitle"),
  ];
  if (questionSet?.description?.trim()) lines.push("", questionSet.description.trim());

  const questions = questionSet?.questions ?? interaction.payload.questions;
  for (const question of questions) {
    lines.push("");
    if ("header" in question && question.header?.trim()) {
      lines.push(question.header.trim());
    }
    lines.push(question.prompt.trim());
    if ("helpText" in question && question.helpText?.trim()) {
      lines.push(question.helpText.trim());
    }
    for (const [index, option] of (question.options ?? []).entries()) {
      const recommendation = "recommended" in option && option.recommended
        ? t(locale, "owner.recommendedOptionSuffix")
        : "";
      lines.push(`${index + 1}. ${option.label.trim()}${recommendation}`);
      if (option.description?.trim()) lines.push(`   ${option.description.trim()}`);
    }
    lines.push(t(locale, QUESTION_REPLY_GUIDANCE_KEY));
  }
  if (taskUrl) lines.push(taskUrl);
  return finishTelegramText(lines);
}

export function telegramOwnerConfirmationText(
  locale: BridgeLocale,
  interaction: RequestConfirmationInteraction,
  taskUrl: string | null,
): string | null {
  const payload = interaction.payload;
  if (payload.secretProposal !== undefined) return null;
  if (
    payload.toolAction !== undefined ||
    payload.connectionAuthorization !== undefined
  ) return null;

  const lines = [payload.prompt.trim()];
  if (payload.detailsMarkdown?.trim()) lines.push("", payload.detailsMarkdown.trim());
  // Only the human label of the target: internal ids, keys, revisions and
  // hrefs of the target never go into the owner message.
  const targetLabel = payload.target?.label?.trim();
  if (targetLabel) {
    lines.push(
      "",
      // myrmidon(1.7-TG-LOCALE): the ru value keeps the pre-localization
      // wording byte-for-byte; the target label is data, not prose.
      t(locale, "owner.confirmationSubject", { target: targetLabel }),
    );
  }
  // Text replies to a confirmation are not resolved by this delivery path, so
  // the message must not promise them: the decision is made on the board.
  lines.push("", t(locale, "owner.boardOnlyReply"));
  if (taskUrl) lines.push("", taskUrl);
  return finishTelegramText(lines);
}

/** Return null for non-owner Telegram publications; the vendor path stays unchanged. */
export function telegramOwnerInteractionText(
  locale: BridgeLocale,
  interaction: IssueThreadInteraction,
  taskUrl: string | null,
  ownerOnly: boolean,
): string | null {
  if (!ownerOnly) return null;
  if (interaction.kind === "ask_user_questions")
    return telegramOwnerQuestionText(locale, interaction, taskUrl);
  if (interaction.kind === "request_confirmation")
    return telegramOwnerConfirmationText(locale, interaction, taskUrl);
  return null;
}
