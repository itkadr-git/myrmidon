import type {
  AskUserQuestionsInteraction,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
} from "@paperclipai/shared";

const MAX_TELEGRAM_MESSAGE_LENGTH = 4_096;
const QUESTION_REPLY_GUIDANCE = "Ответьте сообщением: номером варианта или своими словами.";

function finishTelegramText(lines: string[]): string {
  const text = lines.join("\n").trim();
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
    "",
  ];
  if (questionSet?.description?.trim()) lines.push(questionSet.description.trim(), "");
  if (questionSet) {
    for (const question of questionSet.questions) {
      lines.push(question.header?.trim() || question.prompt.trim());
      if (question.helpText?.trim()) lines.push(question.helpText.trim());
      for (const [index, option] of (question.options ?? []).entries()) {
        const recommendation = option.recommended ? " (рекомендуется)" : "";
        const description = option.description?.trim();
        lines.push(
          `${index + 1}. ${option.label.trim()}${description ? ` — ${description}` : ""}${recommendation}`,
        );
      }
      if (question.customAnswer?.enabled) {
        lines.push(
          `Свободный ответ: ${question.customAnswer.label?.trim() || "своими словами"}${question.customAnswer.placeholder?.trim() ? ` (${question.customAnswer.placeholder.trim()})` : ""}`,
        );
      }
      lines.push(QUESTION_REPLY_GUIDANCE, "");
    }
  } else {
    for (const question of interaction.payload.questions) {
      lines.push(question.prompt.trim());
      if (question.helpText?.trim()) lines.push(question.helpText.trim());
      for (const [index, option] of question.options.entries()) {
        const description = option.description?.trim();
        lines.push(description ? `${index + 1}. ${option.label.trim()} — ${description}` : `${index + 1}. ${option.label.trim()}`);
      }
      lines.push(QUESTION_REPLY_GUIDANCE, "");
    }
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
  if (
    payload.toolAction !== undefined ||
    payload.secretProposal !== undefined ||
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
