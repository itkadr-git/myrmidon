import type {
  AskUserQuestionsInteraction,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
} from "@paperclipai/shared";
import { projectSafeChatPublicationText } from "../../services/chat-publication-projection.js";

const MAX_TELEGRAM_MESSAGE_LENGTH = 4_096;
const QUESTION_REPLY_GUIDANCE = "Ответьте сообщением: номером варианта или своими словами.";

function finishTelegramText(lines: string[]): string {
  const text = projectSafeChatPublicationText(lines.join("\n").trim());
  if (text.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
    throw new Error(
      `Owner interaction text exceeds Telegram's ${MAX_TELEGRAM_MESSAGE_LENGTH}-character message limit`,
    );
  }
  return text;
}

export function telegramOwnerQuestionText(
  interaction: AskUserQuestionsInteraction,
  taskUrl: string | null,
): string {
  const questionSet = interaction.payload.questionSet;
  const lines = [
    questionSet?.title?.trim() ||
      interaction.payload.title?.trim() ||
      interaction.title?.trim() ||
      "Нужен ответ",
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
        ? " (рекомендуется)"
        : "";
      lines.push(`${index + 1}. ${option.label.trim()}${recommendation}`);
      if (option.description?.trim()) lines.push(`   ${option.description.trim()}`);
    }
    lines.push(QUESTION_REPLY_GUIDANCE);
  }
  if (taskUrl) lines.push(taskUrl);
  return finishTelegramText(lines);
}

export function telegramOwnerConfirmationText(
  interaction: RequestConfirmationInteraction,
  taskUrl: string | null,
  nativeTelegramConfirmationAvailable: boolean,
): string | null {
  const payload = interaction.payload;
  if (payload.secretProposal !== undefined) return null;
  if (
    payload.toolAction !== undefined ||
    payload.connectionAuthorization !== undefined
  ) return null;

  const lines = [payload.prompt.trim()];
  if (payload.detailsMarkdown?.trim()) lines.push("", payload.detailsMarkdown.trim());
  if (payload.target != null) {
    lines.push("", "Цель согласования:", JSON.stringify(payload.target));
  }
  const replyCanResolve =
    nativeTelegramConfirmationAvailable &&
    !payload.rejectRequiresReason &&
    payload.target?.type !== "issue_document";
  if (replyCanResolve) {
    lines.push("", "Ответьте сообщением: подтвердите или отклоните, либо своими словами.");
  } else {
    lines.push("", "Ответить можно только на доске.");
  }
  if (taskUrl) lines.push("", taskUrl);
  return finishTelegramText(lines);
}

/** Return null for non-owner Telegram publications; the vendor path stays unchanged. */
export function telegramOwnerInteractionText(
  interaction: IssueThreadInteraction,
  taskUrl: string | null,
  ownerOnly: boolean,
  nativeTelegramConfirmationAvailable: boolean,
): string | null {
  if (!ownerOnly) return null;
  if (interaction.kind === "ask_user_questions")
    return telegramOwnerQuestionText(interaction, taskUrl);
  if (interaction.kind === "request_confirmation")
    return telegramOwnerConfirmationText(
      interaction,
      taskUrl,
      nativeTelegramConfirmationAvailable,
    );
  return null;
}
