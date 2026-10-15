// myrmidon(F06-D): the pure half of the `/model` button menu — token shape,
// the card a list becomes, and its fit into Telegram's callback_data limit.
// The press, the reply-pick and the edited command run against a database in
// server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts.

import { describe, expect, it } from "vitest";
import {
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "../../services/chat-interaction-publications.js";
import type { BridgedChoiceMenu } from "./commands/index.js";
import { t } from "./locales/index.js";
import {
  buildChooserMenuPayload,
  createChooserActionToken,
  isChooserActionId,
  isChooserCardActions,
} from "./chooser-actions.js";

const MENU: BridgedChoiceMenu = {
  commandName: "model",
  title: "Model: model-a (agent default).",
  body: "Available:\n1) model-a\n2) model-b",
  options: [
    { label: "✓ model-a", value: "model-a" },
    { label: "model-b", value: "model-b" },
    { label: "↩ Agent default", value: "default" },
  ],
};

describe("chooser action tokens (F06-D)", () => {
  it("are opaque, unique, recognizable, and fit Telegram's callback_data limit", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createChooserActionToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(isChooserActionId(token)).toBe(true);
      expect(Buffer.byteLength(telegramChatSdkCallbackData(token), "utf8")).toBeLessThanOrEqual(
        TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
      );
    }
  });

  it("are not confused with an issue-interaction action id or free text", () => {
    for (const value of ["pcq:abcdefghijklmnopqrstuv", "pcm:short", "pcm:" + "a".repeat(40), "", null, 7, "model-a"]) {
      expect(isChooserActionId(value)).toBe(false);
    }
  });
});

describe("buildChooserMenuPayload (F06-D)", () => {
  it("makes a card with one callback token per option and no interaction id", () => {
    const { payload, tokens } = buildChooserMenuPayload({ text: "full text", menu: MENU, withButtons: true });
    expect(payload.text).toBe("full text");
    expect(payload.interactionId).toBeUndefined();
    expect(payload.card).toMatchObject({ kind: "status", title: MENU.title, body: MENU.body });
    expect(payload.card!.actions!.map((action) => (action.type === "callback" ? action.label : null))).toEqual([
      "✓ model-a",
      "model-b",
      "↩ Agent default",
    ]);
    expect(tokens.map((token) => token.option.value)).toEqual(["model-a", "model-b", "default"]);
    expect(isChooserCardActions(payload.card!.actions)).toBe(true);
    // The card carries the tokens, never the values they stand for.
    expect(JSON.stringify(payload)).not.toContain('"value"');
  });

  it("is the plain text, with no card and no tokens, where the endpoint takes no actions", () => {
    const { payload, tokens } = buildChooserMenuPayload({ text: "full text", menu: MENU, withButtons: false });
    expect(payload.card).toBeUndefined();
    expect(tokens).toEqual([]);
  });

  it("carries a live-sized list: 30 models and the default button", () => {
    const menu: BridgedChoiceMenu = {
      ...MENU,
      options: [
        ...Array.from({ length: 30 }, (_, i) => ({ label: `dashscope-model-${i}`, value: `dashscope-model-${i}` })),
        { label: "↩ Agent default", value: "default" },
      ],
    };
    const { payload } = buildChooserMenuPayload({ text: "t", menu, withButtons: true });
    expect(payload.card!.actions).toHaveLength(31);
  });

  it("keeps the current-value line of /think as the card title in both languages", () => {
    for (const locale of ["en", "ru"] as const) {
      const title = t(locale, "chooser.effective", {
        label: t(locale, "reasoning.statusLabel"),
        value: "high",
        source: t(locale, "source.thisChat"),
      });
      const { payload } = buildChooserMenuPayload({
        text: title,
        menu: { ...MENU, commandName: "think", title },
        withButtons: true,
      });
      // The publication filter drops a line that starts like hidden reasoning.
      expect(payload.card!.title, locale).toBe(title);
      expect(payload.card!.title.length).toBeGreaterThan(0);
    }
  });

  it("does not treat an interaction card's actions as a choice list", () => {
    expect(isChooserCardActions(undefined)).toBe(false);
    expect(isChooserCardActions([])).toBe(false);
    expect(isChooserCardActions([{ type: "callback", actionId: "pcq:abcdefghijklmnopqrstuv", label: "x" }])).toBe(false);
    expect(isChooserCardActions([{ type: "link", label: "x", url: "https://example.com" }])).toBe(false);
  });
});
