// myrmidon(1.6.5 OPE-6318 part B): a bridged command reply (task_control) may
// carry a card of callback buttons that belongs to no issue interaction — the
// /agents dialog. The projection is the one boundary every external payload
// passes, so it is where the rule is held: only task_control may carry such a
// card, it is persisted without an interaction id (nothing that looks an
// interaction up by id may ever see it), and Telegram's 12-action limit stays.
import { describe, expect, it } from "vitest";
import {
  UnsafeChatPublicationError,
  projectSafeChatPublication,
} from "./chat-publication-projection.js";

const card = {
  kind: "status" as const,
  title: "Agents",
  body: "Choose a direction.",
  actions: [
    { type: "callback" as const, actionId: "pca:abc", label: "Infrastructure (50)" },
    { type: "callback" as const, actionId: "pca:def", label: "Stop", style: "danger" as const },
  ],
};

describe("task_control publications with a standalone card", () => {
  it("persists the card without an interaction id", () => {
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "task_control",
      text: "Agents\n\nChoose a direction.",
      card,
    });
    expect(payload.interactionId).toBeUndefined();
    expect(payload.card).toEqual({
      schema: "paperclip.chat.card.v1",
      kind: "status",
      title: "Agents",
      body: "Choose a direction.",
      actions: [
        { type: "callback", actionId: "pca:abc", label: "Infrastructure (50)" },
        { type: "callback", actionId: "pca:def", label: "Stop", style: "danger" },
      ],
    });
  });

  it("sanitises the card text like any external text", () => {
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "task_control",
      text: "x",
      card: { ...card, body: "Visit javascript:alert(1) now" },
    });
    expect(payload.card?.body).not.toContain("javascript:");
  });

  it("refuses the card from any other source, and next to an interaction card", () => {
    for (const source of ["agent_comment", "explicit_board_send", "safe_milestone", "issue_interaction"] as const) {
      expect(() =>
        projectSafeChatPublication({ classification: "external", source, text: "x", card }),
      ).toThrow(UnsafeChatPublicationError);
    }
    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "task_control",
        text: "x",
        card,
        interaction: { id: "interaction-1", card },
      }),
    ).toThrow(UnsafeChatPublicationError);
  });

  it("keeps the card's own limits: valid kind and ids, at most 12 actions", () => {
    const project = (next: typeof card | Record<string, unknown>) =>
      projectSafeChatPublication({
        classification: "external",
        source: "task_control",
        text: "x",
        card: next as typeof card,
      });
    expect(() => project({ ...card, kind: "bogus" })).toThrow(UnsafeChatPublicationError);
    expect(() =>
      project({ ...card, actions: [{ type: "callback", actionId: "bad id!", label: "x" }] }),
    ).toThrow(UnsafeChatPublicationError);
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      type: "callback" as const,
      actionId: `pca:${index}`,
      label: `b${index}`,
    }));
    expect(project({ ...card, actions: twelve }).card?.actions).toHaveLength(12);
    expect(() => project({ ...card, actions: [...twelve, twelve[0]] })).toThrow(UnsafeChatPublicationError);
  });

  it("leaves a plain task_control text as it was", () => {
    const payload = projectSafeChatPublication({ classification: "external", source: "task_control", text: "ok" });
    expect(payload).toEqual({ text: "ok" });
  });
});
