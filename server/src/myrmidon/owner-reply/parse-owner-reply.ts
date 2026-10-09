// server/src/myrmidon/owner-reply/parse-owner-reply.ts
//
// myrmidon(1.6.5-F21-A): the pure text side of "the owner's own words close the card".
// The owner answers in a chat (a Telegram DM with the authoring agent, or a web
// comment on the task) and this module turns that sentence into a decision, an
// option selection, free text, or an explicit "this is not a decision".
//
// Nothing here reads or writes the database: the caller passes the card it
// already loaded (owner-reply-card.ts builds it from the stored payload) and
// gets a discriminated union back. The union is deliberately narrow so that a
// false close is impossible: an unclear sentence NEVER becomes a decision, it
// becomes `unclear` and the caller asks again.
//
// Language tables are RU + EN (the owner writes Russian by default). A phrase
// table is a set of normalized single words/phrases, never a substring match on
// free prose, so "не надо" cannot be read as "надо".

/** The interaction kinds an owner text answer may close. */
export const OWNER_REPLY_CARD_KINDS = ["ask_user_questions", "request_confirmation"] as const;
export type OwnerReplyCardKind = (typeof OWNER_REPLY_CARD_KINDS)[number];

/** One selectable option of a question card, as the owner sees it. */
export interface OwnerReplyOptionCard {
  id: string;
  label: string;
  recommended: boolean;
  /** The option opens a text field: the owner's words become `otherText`. */
  freeText: boolean;
}

/** One question of an ask_user_questions card. */
export interface OwnerReplyQuestionCard {
  id: string;
  prompt: string;
  selectionMode: "single" | "multi";
  options: OwnerReplyOptionCard[];
}

/** The card a text answer is parsed against. */
export interface OwnerReplyCard {
  interactionId: string;
  kind: OwnerReplyCardKind;
  title: string | null;
  questions: OwnerReplyQuestionCard[];
  acceptLabel: string | null;
  rejectLabel: string | null;
}

/** One answer row in the shape the ordinary respond route accepts. */
export interface OwnerReplySelection {
  questionId: string;
  optionIds: string[];
  otherText: string | null;
}

export type OwnerReplyUnclearReason =
  | "empty"
  | "conflicting_phrases"
  | "unknown_option"
  | "multiple_questions";

/** The parse result: a discriminated union, one branch per outcome. */
export type OwnerReplyParse =
  | { kind: "decision"; decision: "accept" | "reject" }
  | { kind: "selection"; selections: OwnerReplySelection[] }
  | { kind: "comment"; text: string }
  | { kind: "unclear"; reason: OwnerReplyUnclearReason };

/** Lowercase, ё -> е, punctuation -> space, whitespace collapsed. */
export function normalizeOwnerReplyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\sа-я]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Words that start an affirmative answer. Matched as the first token of the
 * sentence ("да, делай" / "ок" / "согласен, но позже").
 */
const OWNER_ACCEPT_PREFIXES: readonly string[] = [
  "да",
  "ага",
  "угу",
  "ок",
  "окей",
  "оке",
  "хорошо",
  "ладно",
  "добро",
  "согласен",
  "согласна",
  "согласны",
  "подтверждаю",
  "подтверждаем",
  "верно",
  "точно",
  "принято",
  "делай",
  "делайте",
  "давай",
  "давайте",
  "запускай",
  "запускайте",
  "продолжай",
  "продолжайте",
  "yes",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "sure",
  "agree",
  "agreed",
  "approve",
  "approved",
  "confirm",
  "confirmed",
  "proceed",
  "go",
  "done",
];

/**
 * Words that start a negative answer. Longer phrases come first so the set is
 * self-documenting; the matcher tests the whole sentence against them too.
 */
const OWNER_REJECT_PREFIXES: readonly string[] = [
  "нет",
  "неа",
  // A bare "не" is deliberately NOT here: "не знаю, что выбрать" and "не уверен,
  // что это сработает" are prose, not answers. Negation is read from the phrases
  // below, which are matched on the head of the sentence as whole words.
  "не надо",
  "не нужно",
  "не стоит",
  "не согласен",
  "не согласна",
  "не согласны",
  "не подтверждаю",
  "не делай",
  "не делайте",
  "не давай",
  "не запускай",
  "не продолжай",
  "отмена",
  "отменить",
  "отменяем",
  "отказ",
  "отказываюсь",
  "стоп",
  "погоди",
  "подожди",
  "позже",
  "не сейчас",
  "no",
  "nope",
  "not",
  "dont",
  "do not",
  "don t",
  "stop",
  "cancel",
  "cancelled",
  "canceled",
  "reject",
  "rejected",
  "decline",
  "declined",
  "never",
  "hold",
  "wait",
];

/** "по твоим рекомендациям", "your recommendation" — pick what the card marks. */
const OWNER_RECOMMENDATION_PATTERN =
  /(рекоменд|по твоему|по твоим|по совету|на твое усмотрение|как скажешь|your recommend|as you recommend|you recommend|your call|your choice)/;

/** "2", "2)", "вариант 2", "вариант б", "option b", "№3" — at the head. */
const OWNER_OPTION_REFERENCE_PATTERN =
  /^(?:вариант|варианта|option|номер|num|variant|item)?\s*([0-9]{1,2}|[a-e]|[а-е])(?:\s|$)/u;

/** True when the sentence opens with an affirmative word ("да, делай"). */
export function ownerReplyAccepts(normalized: string): boolean {
  const first = normalized.split(" ")[0] ?? "";
  if (OWNER_REJECT_PREFIXES.includes(first)) return false;
  if (OWNER_ACCEPT_PREFIXES.includes(first)) return true;
  return OWNER_ACCEPT_PREFIXES.includes(normalized);
}

/** True when the sentence opens with a negative word ("нет, стоп", "не надо"). */
export function ownerReplyRejects(normalized: string): boolean {
  const first = normalized.split(" ")[0] ?? "";
  if (OWNER_REJECT_PREFIXES.includes(first)) return true;
  // "не надо", "do not" — multi-word prefixes are matched as whole words.
  return OWNER_REJECT_PREFIXES.some(
    (word) => word.includes(" ") && (normalized === word || normalized.startsWith(`${word} `)),
  );
}

/** True when the owner delegates the choice to the card's recommendation. */
export function ownerReplyMentionsRecommendation(normalized: string): boolean {
  return OWNER_RECOMMENDATION_PATTERN.test(normalized);
}

function optionMatchesReference(question: OwnerReplyQuestionCard, reference: string): OwnerReplyOptionCard[] {
  if (!/^[0-9]+$/.test(reference)) {
    // "а"/"б"/"в" and "a"/"b"/"c" are the same positions, 1, 2, 3.
    const cyrillic = reference.charCodeAt(0) - "а".charCodeAt(0);
    const latin = reference.charCodeAt(0) - "a".charCodeAt(0);
    const index = cyrillic >= 0 && cyrillic < 5 ? cyrillic : latin;
    const byLetter = question.options[index];
    return byLetter ? [byLetter] : [];
  }
  const byIndex = question.options[Number.parseInt(reference, 10) - 1];
  return byIndex ? [byIndex] : [];
}

/** The options of one question whose label appears verbatim in the sentence. */
function optionMatchesLabel(question: OwnerReplyQuestionCard, normalized: string): OwnerReplyOptionCard[] {
  return question.options.filter((option) => {
    const label = normalizeOwnerReplyText(option.label);
    return label.length >= 2 && normalized.includes(label);
  });
}

/** Every question that the sentence points at, with the options it points at. */
function matchQuestionOptions(
  card: OwnerReplyCard,
  normalized: string,
): Array<{ question: OwnerReplyQuestionCard; options: OwnerReplyOptionCard[] }> {
  const reference = OWNER_OPTION_REFERENCE_PATTERN.exec(normalized)?.[1] ?? null;
  const matches: Array<{ question: OwnerReplyQuestionCard; options: OwnerReplyOptionCard[] }> = [];
  for (const question of card.questions) {
    const byReference = reference ? optionMatchesReference(question, reference) : [];
    const options = byReference.length > 0 ? byReference : optionMatchesLabel(question, normalized);
    if (options.length > 0) matches.push({ question, options });
  }
  return matches;
}

/** The options the card marks as recommended, per question. */
function recommendedOptions(card: OwnerReplyCard): Array<{ question: OwnerReplyQuestionCard; options: OwnerReplyOptionCard[] }> {
  const picked: Array<{ question: OwnerReplyQuestionCard; options: OwnerReplyOptionCard[] }> = [];
  for (const question of card.questions) {
    const recommended = question.options.filter((option) => option.recommended);
    if (recommended.length === 1) picked.push({ question, options: recommended });
  }
  return picked;
}

function toSelections(
  matches: Array<{ question: OwnerReplyQuestionCard; options: OwnerReplyOptionCard[] }>,
  otherText: string | null,
): OwnerReplySelection[] {
  return matches.map((match) => ({
    questionId: match.question.id,
    optionIds: match.options.map((option) => option.id),
    otherText: match.options.some((option) => option.freeText) ? otherText : null,
  }));
}

/**
 * Parse the owner's sentence against the card it answers.
 *
 * request_confirmation: an affirmative sentence is `accept`, a negative one is
 * `reject`, both words in one sentence is `unclear` (never a close), and any
 * other sentence is `comment` — free text the caller records while the card
 * stays pending.
 *
 * ask_user_questions: an explicit option reference (number, letter, label or
 * "по твоим рекомендациям") is a `selection`; free text on a single question is
 * a `selection` carrying the words as `otherText`; anything ambiguous is
 * `unclear` (the caller asks again) — a guess never closes a card.
 */
export function parseOwnerReply(input: { text: string; card: OwnerReplyCard }): OwnerReplyParse {
  const normalized = normalizeOwnerReplyText(input.text);
  if (normalized.length === 0) return { kind: "unclear", reason: "empty" };

  const accepts = ownerReplyAccepts(normalized);
  const rejects = ownerReplyRejects(normalized);
  if (accepts && rejects) return { kind: "unclear", reason: "conflicting_phrases" };

  if (input.card.kind === "request_confirmation") {
    if (rejects && !accepts) return { kind: "decision", decision: "reject" };
    if (accepts && !rejects) return { kind: "decision", decision: "accept" };
    return { kind: "comment", text: input.text.trim() };
  }

  const matches = matchQuestionOptions(input.card, normalized);
  if (matches.length > 1) return { kind: "unclear", reason: "multiple_questions" };
  if (matches.length === 1) {
    const [match] = matches;
    if (!match) return { kind: "unclear", reason: "unknown_option" };
    if (match.options.length > 1 && match.question.selectionMode === "single") {
      return { kind: "unclear", reason: "unknown_option" };
    }
    return { kind: "selection", selections: toSelections(matches, null) };
  }

  if (ownerReplyMentionsRecommendation(normalized)) {
    const recommended = recommendedOptions(input.card);
    if (recommended.length === 0) return { kind: "unclear", reason: "unknown_option" };
    if (recommended.length > 1) return { kind: "unclear", reason: "multiple_questions" };
    return { kind: "selection", selections: toSelections(recommended, null) };
  }

  // Free text: an answer only when there is nothing to confuse it with.
  if (input.card.questions.length !== 1) return { kind: "unclear", reason: "multiple_questions" };
  const [question] = input.card.questions;
  if (!question) return { kind: "unclear", reason: "unknown_option" };
  const freeTextOption = question.options.find((option) => option.freeText);
  if (freeTextOption) {
    return {
      kind: "selection",
      selections: [{ questionId: question.id, optionIds: [freeTextOption.id], otherText: input.text.trim() }],
    };
  }
  if (question.options.length > 0) {
    // The question wants a pick from closed options: words alone pick nothing.
    return { kind: "unclear", reason: "unknown_option" };
  }
  return {
    kind: "selection",
    selections: [{ questionId: question.id, optionIds: [], otherText: input.text.trim() }],
  };
}