// myrmidon(F06-D): a plain card — one that belongs to no issue interaction —
// is the shape of the `/model` and `/think` button lists. It must never carry
// an interaction id (nothing that resolves interactions may pick it up), and
// it may hold more buttons than an interaction card does.

import { describe, expect, it } from "vitest";
import { projectSafeChatPublication } from "./chat-publication-projection.js";

const callback = (index: number) => ({
  type: "callback" as const,
  actionId: `pcm:action-${index}`,
  label: `model-${index}`,
});

describe("projectSafeChatPublication plain card (F06-D)", () => {
  it("projects a card with no interaction id", () => {
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "task_control",
      text: "list",
      card: { kind: "status", title: "Model: model-a.", body: "Available:\n1) model-a", actions: [callback(1)] },
    });
    expect(payload.interactionId).toBeUndefined();
    expect(payload.card).toEqual({
      schema: "paperclip.chat.card.v1",
      kind: "status",
      title: "Model: model-a.",
      body: "Available:\n1) model-a",
      actions: [{ type: "callback", actionId: "pcm:action-1", label: "model-1" }],
    });
  });

  it("holds up to 100 buttons (Telegram's per-message limit), where an interaction card holds 12", () => {
    const actions = Array.from({ length: 100 }, (_, i) => callback(i));
    expect(
      projectSafeChatPublication({
        classification: "external",
        source: "task_control",
        text: "list",
        card: { kind: "status", title: "t", actions },
      }).card?.actions,
    ).toHaveLength(100);
    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "task_control",
        text: "list",
        card: { kind: "status", title: "t", actions: [...actions, callback(100)] },
      }),
    ).toThrow(/at most 100/);
    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "issue_interaction",
        text: "q",
        interaction: {
          id: "interaction-1",
          card: { kind: "question", title: "t", actions: Array.from({ length: 13 }, (_, i) => callback(i)) },
        },
      }),
    ).toThrow(/at most 12/);
  });

  it("refuses an interaction card and a plain card on one publication", () => {
    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "task_control",
        text: "x",
        interaction: { id: "interaction-1", card: { kind: "status", title: "t" } },
        card: { kind: "status", title: "t" },
      }),
    ).toThrow(/not both/);
  });

  it("keeps the label sanitation of every card", () => {
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "task_control",
      text: "x",
      card: {
        kind: "status",
        title: "t",
        actions: [{ type: "callback", actionId: "pcm:action-1", label: "x".repeat(200) }],
      },
    });
    const action = payload.card!.actions![0]!;
    expect(action.type === "callback" && action.label.length).toBeLessThanOrEqual(80);
  });
});
