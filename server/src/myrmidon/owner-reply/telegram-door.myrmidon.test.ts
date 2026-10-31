import { describe, expect, it, vi } from "vitest";
// myrmidon(1.6.6-U2-REPLY): the Telegram door of the owner's words. The
// database is faked: the point is which cards a reply may close and that the
// owner is the resolver.
import type { OwnerReplyCard } from "./parse-owner-reply.js";
import type { PendingOwnerCard } from "./pending-owner-cards.js";
import type { OwnerReplyDeps } from "./owner-task-reply.js";
import { handleTelegramOwnerReply, narrowCardsToReply } from "./telegram-door.js";

const OWNER = "user-owner";
const COMPANY = "company-1";

function confirmation(interactionId: string): PendingOwnerCard {
  const card: OwnerReplyCard = {
    interactionId,
    kind: "request_confirmation",
    title: "Выкатить?",
    questions: [],
    acceptLabel: null,
    rejectLabel: null,
  };
  return {
    interactionId,
    companyId: COMPANY,
    issueId: "issue-1",
    issueIdentifier: "TASK-1",
    issueTitle: "Выкат",
    kind: "request_confirmation",
    ownerUserId: OWNER,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    payload: { title: "Выкатить?" },
    card,
    assigneeAgentId: null,
  };
}

function setup(cards: PendingOwnerCard[]) {
  const resolveCard = vi.fn(async () => ({ status: "accepted" }));
  const askWhichCard = vi.fn(async () => undefined);
  const deps: OwnerReplyDeps = {
    readMode: async () => "via_bot",
    listCards: async () => cards,
    loadReaskMarks: async () => [],
    resolveCard: resolveCard as unknown as OwnerReplyDeps["resolveCard"],
    reaskCard: vi.fn(async () => undefined) as unknown as OwnerReplyDeps["reaskCard"],
    askWhichCard: askWhichCard as unknown as OwnerReplyDeps["askWhichCard"],
  };
  return { deps, resolveCard, askWhichCard };
}

const base = {
  companyId: COMPANY,
  ownerUserId: OWNER,
  agentId: "agent-a",
  replyCommentId: "comment-1",
  sourceRef: "telegram-delivery:d-1",
  at: new Date("2026-01-02T00:00:00Z"),
};

describe("narrowCardsToReply", () => {
  const cards = [confirmation("ix-1"), confirmation("ix-2")];
  it("keeps every card when the message replies to nothing", () => {
    expect(narrowCardsToReply(cards, null)).toHaveLength(2);
  });
  it("keeps only the cards the replied-to message explained", () => {
    expect(narrowCardsToReply(cards, ["ix-2"]).map((c) => c.interactionId)).toEqual(["ix-2"]);
  });
  it("keeps nothing when the replied-to message explained nothing", () => {
    expect(narrowCardsToReply(cards, [])).toEqual([]);
  });
});

describe("handleTelegramOwnerReply", () => {
  it("closes the single explained card as the owner when the message replies to nothing", async () => {
    const { deps, resolveCard } = setup([confirmation("ix-1")]);
    const outcome = await handleTelegramOwnerReply(deps, { ...base, text: "да", loadReplied: null });
    expect(outcome).toMatchObject({ outcome: "resolved", interactionId: "ix-1", action: "accept" });
    expect(resolveCard).toHaveBeenCalledTimes(1);
    expect(resolveCard).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: OWNER, replyCommentId: "comment-1", action: "accept" }),
    );
  });

  it("asks which card when several are open and the message replies to nothing", async () => {
    const { deps, resolveCard, askWhichCard } = setup([confirmation("ix-1"), confirmation("ix-2")]);
    const outcome = await handleTelegramOwnerReply(deps, { ...base, text: "да", loadReplied: null });
    expect(outcome.outcome).toBe("asked_which_card");
    expect(askWhichCard).toHaveBeenCalledTimes(1);
    expect(resolveCard).not.toHaveBeenCalled();
  });

  it("closes exactly the card a reply points at, even with several open", async () => {
    const { deps, resolveCard, askWhichCard } = setup([confirmation("ix-1"), confirmation("ix-2")]);
    const outcome = await handleTelegramOwnerReply(deps, {
      ...base,
      text: "нет",
      loadReplied: async () => ["ix-2"],
    });
    expect(outcome).toMatchObject({ outcome: "resolved", interactionId: "ix-2", action: "reject" });
    expect(askWhichCard).not.toHaveBeenCalled();
    expect(resolveCard).toHaveBeenCalledTimes(1);
  });

  it("never falls back to another card when the reply points at a stale message", async () => {
    const { deps, resolveCard, askWhichCard } = setup([confirmation("ix-1")]);
    const outcome = await handleTelegramOwnerReply(deps, {
      ...base,
      text: "да",
      loadReplied: async () => [],
    });
    expect(outcome).toEqual({ outcome: "no_card" });
    expect(resolveCard).not.toHaveBeenCalled();
    expect(askWhichCard).not.toHaveBeenCalled();
  });

  it("stays out of the way outside the via_bot mode", async () => {
    const { deps, resolveCard } = setup([confirmation("ix-1")]);
    const outcome = await handleTelegramOwnerReply(
      { ...deps, readMode: async () => "all" as never },
      { ...base, text: "да", loadReplied: null },
    );
    expect(outcome.outcome).toBe("skipped_mode");
    expect(resolveCard).not.toHaveBeenCalled();
  });
});
