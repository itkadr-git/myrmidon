import { describe, expect, it, vi } from "vitest";
// myrmidon(1.6.6-U2-REPLY): the Telegram door of the owner's words. The
// database is faked: the point is which cards a reply may close and that the
// owner is the resolver.
import type { OwnerReplyCard } from "./parse-owner-reply.js";
import type { PendingOwnerCard } from "./pending-owner-cards.js";
import type { OwnerReplyDeps } from "./owner-task-reply.js";
import { handleTelegramOwnerReply, loadRepliedInteractionIds, narrowCardsToReply, shouldSuppressTelegramOwnerWake } from "./telegram-door.js";
import { listOwnerExplanations } from "../owner-delivery/owner-dialogue.js";

vi.mock("../owner-delivery/owner-dialogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owner-delivery/owner-dialogue.js")>();
  return {
    ...actual,
    listOwnerExplanations: vi.fn(),
  };
});

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

  it.each([
    ["resolved", { outcome: "resolved", interactionId: "ix-1", action: "accept", status: "accepted" }, false, true],
    ["multi-card clarification", { outcome: "asked_which_card", interactionIds: ["ix-1", "ix-2"] }, false, true],
    ["stale explicit reply", { outcome: "no_card" }, true, true],
    ["unmatched no-reply", { outcome: "no_card" }, false, false],
    ["ambiguous answer", { outcome: "kept_pending", interactionId: "ix-1", reason: "ambiguous", status: "pending" }, true, false],
    ["failed resolution", { outcome: "failed", error: "failure" }, true, false],
    ["non-via-bot mode skipped", { outcome: "skipped_mode", mode: "via_bot" }, true, false],
  ] as const)("wake settlement: %s", (_label, outcome, hasReplyTarget, expected) => {
    expect(shouldSuppressTelegramOwnerWake(outcome, hasReplyTarget)).toBe(expected);
  });

  it("rejects a reply target from another Telegram chat before consulting links", async () => {
    const select = vi.fn();
    const db = { select } as never;
    await expect(
      loadRepliedInteractionIds(db, {
        companyId: COMPANY,
        endpointId: "endpoint-1",
        conversationId: "conversation-1",
        conversationIssueId: "issue-1",
        conversationExternalId: "telegram:100",
        agentId: "agent-a",
        replyToProviderMessageId: "telegram:200:42",
      }),
    ).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("returns interaction ids when provider message matches chatMessageLinks and owner explanations", async () => {
    const limit = vi.fn().mockReturnValue(Promise.resolve([{ commentId: "comment-42" }]));
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as never;

    vi.mocked(listOwnerExplanations).mockResolvedValueOnce([
      { commentId: "comment-42", createdAt: new Date(), interactionIds: ["ix-42"] },
    ]);

    const result = await loadRepliedInteractionIds(db, {
      companyId: COMPANY,
      endpointId: "endpoint-1",
      conversationId: "conversation-1",
      conversationIssueId: "issue-1",
      conversationExternalId: "telegram:100",
      agentId: "agent-a",
      replyToProviderMessageId: "telegram:100:42",
    });

    expect(result).toEqual(["ix-42"]);
    expect(select).toHaveBeenCalled();
    expect(from).toHaveBeenCalled();
    expect(where).toHaveBeenCalled();
    expect(listOwnerExplanations).toHaveBeenCalledWith(db, {
      companyId: COMPANY,
      conversationIssueId: "issue-1",
      agentId: "agent-a",
    });
  });

  it("returns empty array when link is not found or has null commentId", async () => {
    const limit = vi.fn().mockReturnValue(Promise.resolve([]));
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as never;

    const result = await loadRepliedInteractionIds(db, {
      companyId: COMPANY,
      endpointId: "endpoint-1",
      conversationId: "conversation-1",
      conversationIssueId: "issue-1",
      conversationExternalId: "telegram:100",
      agentId: "agent-a",
      replyToProviderMessageId: "telegram:100:42",
    });

    expect(result).toEqual([]);
  });

  it("accepts published owner decisions in owner_decisions_only and all modes", async () => {
    for (const mode of ["owner_decisions_only", "all"] as const) {
      const { deps, resolveCard } = setup([confirmation("ix-1")]);
      const outcome = await handleTelegramOwnerReply(
        { ...deps, readMode: async () => mode },
        { ...base, text: "да", loadReplied: null },
      );
      expect(outcome).toMatchObject({ outcome: "resolved", interactionId: "ix-1" });
      expect(resolveCard).toHaveBeenCalledTimes(1);
    }
  });

  describe("F21 compatibility: autoCloseOwnerDecisionOnOwnerComment", () => {
    it("does not double-close when an open card was already auto-closed", async () => {
      // If F21 already closed the single pending decision on the issue, listCards is empty:
      const { deps, resolveCard, askWhichCard } = setup([]);
      const outcome = await handleTelegramOwnerReply(deps, {
        ...base,
        text: "да",
        loadReplied: null,
      });
      expect(outcome).toEqual({ outcome: "no_card" });
      expect(resolveCard).not.toHaveBeenCalled();
      expect(askWhichCard).not.toHaveBeenCalled();
      expect(shouldSuppressTelegramOwnerWake(outcome, false)).toBe(false);
    });

    it("resolves only targeted interaction and leaves other cards untouched when one was auto-closed", async () => {
      // When one card was auto-closed by F21 and ix-2 remains open:
      const { deps, resolveCard, askWhichCard } = setup([confirmation("ix-2")]);
      const outcome = await handleTelegramOwnerReply(deps, {
        ...base,
        text: "да",
        loadReplied: async () => ["ix-2"],
      });
      expect(outcome).toMatchObject({ outcome: "resolved", interactionId: "ix-2", action: "accept" });
      expect(resolveCard).toHaveBeenCalledTimes(1);
      expect(askWhichCard).not.toHaveBeenCalled();
    });

    it("does not close wrong card when reply points to an already-closed or foreign interaction", async () => {
      // Reply pointed to an interaction that is already closed (not returned in listCards):
      const { deps, resolveCard, askWhichCard } = setup([confirmation("ix-2")]);
      const outcome = await handleTelegramOwnerReply(deps, {
        ...base,
        text: "да",
        loadReplied: async () => ["ix-1"],
      });
      expect(outcome).toEqual({ outcome: "no_card" });
      expect(resolveCard).not.toHaveBeenCalled();
      expect(askWhichCard).not.toHaveBeenCalled();
      expect(shouldSuppressTelegramOwnerWake(outcome, true)).toBe(true);
    });
  });

  describe("idempotency and duplicate delivery settlement", () => {
    it("suppresses wake deterministically on duplicate delivery with explicit reply", () => {
      const outcome = { outcome: "resolved" as const, interactionId: "ix-1", action: "accept" as const, status: "accepted" as const };
      expect(shouldSuppressTelegramOwnerWake(outcome, true)).toBe(true);
      // Duplicate delivery where card was already resolved and now reports no_card with reply target:
      const duplicateStaleOutcome = { outcome: "no_card" as const };
      expect(shouldSuppressTelegramOwnerWake(duplicateStaleOutcome, true)).toBe(true);
    });

    it("does not re-ask when answerKey mark already exists for delivery", async () => {
      const { deps } = setup([confirmation("ix-1"), confirmation("ix-2")]);
      const depsWithMark: OwnerReplyDeps = {
        ...deps,
        loadReaskMarks: async () => ["ix-1", "ix-2"],
      };
      await handleTelegramOwnerReply(depsWithMark, {
        ...base,
        text: "непонятно",
        loadReplied: null,
      });
      expect(deps.reaskCard).not.toHaveBeenCalled();
    });
  });
});
