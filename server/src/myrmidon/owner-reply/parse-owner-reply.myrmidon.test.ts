import { describe, expect, it } from "vitest";
// myrmidon(1.6.5-F21-A): the phrase table, as the ticket writes it — each case
// is a sentence an owner actually types and the decision it must produce.
import {
  normalizeOwnerReplyText,
  parseOwnerReply,
  type OwnerReplyCard,
} from "./parse-owner-reply.js";

function confirmationCard(overrides: Partial<OwnerReplyCard> = {}): OwnerReplyCard {
  return {
    interactionId: "ix-confirm",
    kind: "request_confirmation",
    title: "Deploy the fix to staging?",
    questions: [],
    acceptLabel: null,
    rejectLabel: null,
    ...overrides,
  };
}

function questionCard(questions: OwnerReplyCard["questions"]): OwnerReplyCard {
  return {
    interactionId: "ix-question",
    kind: "ask_user_questions",
    title: "How should we roll this out?",
    questions,
    acceptLabel: null,
    rejectLabel: null,
  };
}

const THREE_OPTIONS = [
  {
    id: "opt-morning",
    label: "Утром",
    recommended: false,
    freeText: false,
  },
  {
    id: "opt-evening",
    label: "Вечером",
    recommended: false,
    freeText: false,
  },
  {
    id: "opt-night",
    label: "Ночью",
    recommended: true,
    freeText: false,
  },
];

describe("normalizeOwnerReplyText", () => {
  it("lowercases, drops punctuation and collapses whitespace", () => {
    expect(normalizeOwnerReplyText("  Да,   ДЕЛАЙ!  ")).toBe("да делай");
  });

  it("normalizes ё to е so both spellings answer the same phrase", () => {
    expect(normalizeOwnerReplyText("ещё раз")).toBe("еще раз");
  });
});

describe("parseOwnerReply: request_confirmation", () => {
  it("reads an affirmative sentence as accept", () => {
    expect(parseOwnerReply({ text: "да, делай", card: confirmationCard() })).toEqual({
      kind: "decision",
      decision: "accept",
    });
    expect(parseOwnerReply({ text: "ОК", card: confirmationCard() })).toEqual({
      kind: "decision",
      decision: "accept",
    });
    expect(parseOwnerReply({ text: "согласен", card: confirmationCard() })).toEqual({
      kind: "decision",
      decision: "accept",
    });
    expect(parseOwnerReply({ text: "yes, proceed", card: confirmationCard() })).toEqual({
      kind: "decision",
      decision: "accept",
    });
  });

  it("reads a negative sentence as reject", () => {
    expect(parseOwnerReply({ text: "нет", card: confirmationCard() })).toEqual({
      kind: "decision",
      decision: "reject",
    });
    expect(parseOwnerReply({ text: "не надо", card: confirmationCard() })).toEqual({
      kind: "decision",
      decision: "reject",
    });
    expect(parseOwnerReply({ text: "стоп, отменяем", card: confirmationCard() })).toEqual({
      kind: "decision",
      decision: "reject",
    });
  });

  it("never closes the card on prose that merely contains an affirmative word", () => {
    // The phrase table matches the head of the sentence, never a substring:
    // "подумаю, да потом скажу" is a comment, not a yes.
    expect(parseOwnerReply({ text: "подумаю, да потом скажу", card: confirmationCard() })).toEqual({
      kind: "comment",
      text: "подумаю, да потом скажу",
    });
    expect(parseOwnerReply({ text: "не знаю, что тут выбрать", card: confirmationCard() })).toEqual({
      kind: "comment",
      text: "не знаю, что тут выбрать",
    });
  });

  it("treats an empty sentence as unclear, not as an answer", () => {
    expect(parseOwnerReply({ text: "   ", card: confirmationCard() })).toEqual({
      kind: "unclear",
      reason: "empty",
    });
  });
});

describe("parseOwnerReply: ask_user_questions", () => {
  it("picks the option by its number, as the owner sees it in the buttons", () => {
    const card = questionCard([{ id: "q-1", prompt: "Когда?", selectionMode: "single", options: THREE_OPTIONS }]);
    expect(parseOwnerReply({ text: "2) да", card })).toEqual({
      kind: "selection",
      selections: [{ questionId: "q-1", optionIds: ["opt-evening"], otherText: null }],
    });
  });

  it("picks the option by its position letter", () => {
    const card = questionCard([{ id: "q-1", prompt: "Когда?", selectionMode: "single", options: THREE_OPTIONS }]);
    expect(parseOwnerReply({ text: "вариант б", card })).toEqual({
      kind: "selection",
      selections: [{ questionId: "q-1", optionIds: ["opt-evening"], otherText: null }],
    });
  });

  it("picks the option whose label the owner repeats", () => {
    const card = questionCard([{ id: "q-1", prompt: "Когда?", selectionMode: "single", options: THREE_OPTIONS }]);
    expect(parseOwnerReply({ text: "давай вечером", card })).toEqual({
      kind: "selection",
      selections: [{ questionId: "q-1", optionIds: ["opt-evening"], otherText: null }],
    });
  });

  it("follows the card's recommendation when the owner defers", () => {
    const card = questionCard([{ id: "q-1", prompt: "Когда?", selectionMode: "single", options: THREE_OPTIONS }]);
    expect(parseOwnerReply({ text: "по твоим рекомендациям", card })).toEqual({
      kind: "selection",
      selections: [{ questionId: "q-1", optionIds: ["opt-night"], otherText: null }],
    });
  });

  it("does not close a card that marks no recommendation", () => {
    const options = THREE_OPTIONS.map((option) => ({ ...option, recommended: false }));
    const card = questionCard([{ id: "q-1", prompt: "Когда?", selectionMode: "single", options }]);
    expect(parseOwnerReply({ text: "по твоим рекомендациям", card })).toEqual({
      kind: "unclear",
      reason: "unknown_option",
    });
  });

  it("keeps the card open when closed options get only free words", () => {
    const card = questionCard([{ id: "q-1", prompt: "Когда?", selectionMode: "single", options: THREE_OPTIONS }]);
    expect(parseOwnerReply({ text: "потом решим", card })).toEqual({
      kind: "unclear",
      reason: "unknown_option",
    });
  });

  it("carries free words as otherText when the option opens a text field", () => {
    const card = questionCard([
      {
        id: "q-1",
        prompt: "Что добавить?",
        selectionMode: "single",
        options: [
          { id: "opt-free", label: "Своё", recommended: false, freeText: true },
          { id: "opt-none", label: "Ничего", recommended: false, freeText: false },
        ],
      },
    ]);
    expect(parseOwnerReply({ text: "добавь проверку типов", card })).toEqual({
      kind: "selection",
      selections: [{ questionId: "q-1", optionIds: ["opt-free"], otherText: "добавь проверку типов" }],
    });
  });

  it("carries free words as an answer when the question has no options at all", () => {
    const card = questionCard([{ id: "q-1", prompt: "Комментарий?", selectionMode: "single", options: [] }]);
    expect(parseOwnerReply({ text: "нужен ещё один прогон", card })).toEqual({
      kind: "selection",
      selections: [{ questionId: "q-1", optionIds: [], otherText: "нужен ещё один прогон" }],
    });
  });

  it("asks again instead of guessing when two questions could be meant", () => {
    const card = questionCard([
      { id: "q-1", prompt: "Когда?", selectionMode: "single", options: THREE_OPTIONS },
      { id: "q-2", prompt: "Где?", selectionMode: "single", options: THREE_OPTIONS },
    ]);
    expect(parseOwnerReply({ text: "вечером", card })).toEqual({
      kind: "unclear",
      reason: "multiple_questions",
    });
  });

  it("picks the single recommended question out of several", () => {
    const card = questionCard([
      {
        id: "q-1",
        prompt: "Когда?",
        selectionMode: "single",
        options: THREE_OPTIONS.map((option) => ({ ...option, recommended: false })),
      },
      { id: "q-2", prompt: "Где?", selectionMode: "single", options: THREE_OPTIONS },
    ]);
    expect(parseOwnerReply({ text: "по твоим рекомендациям", card })).toEqual({
      kind: "selection",
      selections: [{ questionId: "q-2", optionIds: ["opt-night"], otherText: null }],
    });
  });

  it("refuses a closed single-choice card that matches several options at once", () => {
    const card = questionCard([
      {
        id: "q-1",
        prompt: "Когда?",
        selectionMode: "single",
        options: [
          { id: "opt-morning", label: "Утром в понедельник", recommended: false, freeText: false },
          { id: "opt-evening", label: "Вечером в понедельник", recommended: false, freeText: false },
        ],
      },
    ]);
    expect(parseOwnerReply({ text: "в понедельник", card })).toEqual({
      kind: "unclear",
      reason: "unknown_option",
    });
  });
});