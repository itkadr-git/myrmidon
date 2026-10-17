import { describe, expect, it, vi } from "vitest";
// myrmidon(1.6.5-F21-A): plan + handler, with the database faked. The real
// services are what CI's embedded-PG tier exercises; here the point is that the
// decisions are taken from the sentence and the cards, and written once.
import type { Db } from "@paperclipai/db";
import type { OwnerReplyCard } from "./parse-owner-reply.js";
import { listPendingOwnerCardsForIssue, type PendingOwnerCard } from "./pending-owner-cards.js";
import { planOwnerReply } from "./owner-reply-plan.js";
import { handleOwnerTextReply, type OwnerReplyDeps } from "./owner-task-reply.js";

const OWNER = "user-owner";
const OTHER_USER = "user-someone";
const COMPANY = "company-1";
const ISSUE = "issue-1";

function confirmationCard(interactionId: string, createdAt: Date): PendingOwnerCard {
  const card: OwnerReplyCard = {
    interactionId,
    kind: "request_confirmation",
    title: "Deploy the fix to staging?",
    questions: [],
    acceptLabel: null,
    rejectLabel: null,
  };
  return {
    interactionId,
    companyId: COMPANY,
    issueId: ISSUE,
    issueIdentifier: "TASK-1",
    issueTitle: "Deploy the fix",
    kind: "request_confirmation",
    ownerUserId: OWNER,
    createdAt,
    payload: { title: "Deploy the fix to staging?" },
    card,
    assigneeAgentId: "agent-a",
  };
}

function questionCard(interactionId: string, createdAt: Date): PendingOwnerCard {
  const card: OwnerReplyCard = {
    interactionId,
    kind: "ask_user_questions",
    title: "How should we roll this out?",
    questions: [
      {
        id: "q-1",
        prompt: "Когда?",
        selectionMode: "single",
        options: [
          { id: "opt-morning", label: "Утром", recommended: false, freeText: false },
          { id: "opt-evening", label: "Вечером", recommended: false, freeText: false },
        ],
      },
    ],
    acceptLabel: null,
    rejectLabel: null,
  };
  return {
    interactionId,
    companyId: COMPANY,
    issueId: ISSUE,
    issueIdentifier: "TASK-1",
    issueTitle: "Roll out",
    kind: "ask_user_questions",
    ownerUserId: OWNER,
    createdAt,
    payload: {},
    card,
    assigneeAgentId: "agent-a",
  };
}

interface StubCalls {
  resolveCard: ReturnType<typeof vi.fn>;
  reaskCard: ReturnType<typeof vi.fn>;
  askWhichCard: ReturnType<typeof vi.fn>;
  loadReaskMarks: ReturnType<typeof vi.fn>;
}

function stubDeps(input: {
  mode?: string;
  cards: PendingOwnerCard[];
  reasked?: string[];
  resolveCard?: (value: unknown) => Promise<{ status: string }>;
}): { deps: OwnerReplyDeps; calls: StubCalls } {
  const calls: StubCalls = {
    resolveCard: vi.fn(input.resolveCard ?? (async () => ({ status: "accepted" }))),
    reaskCard: vi.fn(async () => undefined),
    askWhichCard: vi.fn(async () => undefined),
    loadReaskMarks: vi.fn(async () => input.reasked ?? []),
  };
  const deps: OwnerReplyDeps = {
    readMode: async () => (input.mode ?? "via_bot") as never,
    listCards: async () => input.cards,
    loadReaskMarks: calls.loadReaskMarks as unknown as OwnerReplyDeps["loadReaskMarks"],
    resolveCard: calls.resolveCard as unknown as OwnerReplyDeps["resolveCard"],
    reaskCard: calls.reaskCard as unknown as OwnerReplyDeps["reaskCard"],
    askWhichCard: calls.askWhichCard as unknown as OwnerReplyDeps["askWhichCard"],
  };
  return { deps, calls };
}

function webCommentInput(text: string) {
  return {
    companyId: COMPANY,
    ownerUserId: OWNER,
    text,
    issueId: ISSUE,
    replyCommentId: "comment-1",
    sourceRef: "comment:comment-1",
  };
}

describe("planOwnerReply", () => {
  it("does nothing when the owner has no pending card", () => {
    expect(planOwnerReply({ text: "да", cards: [] })).toEqual({ kind: "none" });
  });

  it("asks which card when several are pending", () => {
    const cards = [
      confirmationCard("ix-new", new Date("2026-01-02T00:00:00Z")),
      questionCard("ix-old", new Date("2026-01-01T00:00:00Z")),
    ];
    const plan = planOwnerReply({ text: "да", cards });
    expect(plan.kind).toBe("ask_which_card");
  });

  it("closes a single confirmation card on a decision", () => {
    const cards = [confirmationCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    expect(planOwnerReply({ text: "да, делай", cards })).toEqual({
      kind: "resolve",
      card: cards[0],
      action: "accept",
      body: {},
    });
  });

  it("closes a question card through a respond body", () => {
    const cards = [questionCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    const plan = planOwnerReply({ text: "2) да", cards });
    expect(plan).toEqual({
      kind: "resolve",
      card: cards[0],
      action: "respond",
      body: {
        answers: [{ questionId: "q-1", optionIds: ["opt-evening"], otherText: null }],
      },
    });
  });

  it("keeps the card pending on words that decide nothing, and re-asks once", () => {
    const cards = [confirmationCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    expect(planOwnerReply({ text: "подумаю, да потом скажу", cards })).toEqual({
      kind: "keep_pending",
      card: cards[0],
      reason: "answered_without_decision",
      text: "подумаю, да потом скажу",
      reask: true,
    });
    const again = planOwnerReply({ text: "подумаю", cards, alreadyReaskedFor: ["ix-1"] });
    expect(again.kind).toBe("keep_pending");
    expect(again.kind === "keep_pending" ? again.reask : null).toBe(false);
  });
});

describe("handleOwnerTextReply", () => {
  it("stays out of the way in every owner delivery mode but via_bot", async () => {
    const cards = [confirmationCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    const { deps, calls } = stubDeps({ mode: "board_only", cards });
    await expect(handleOwnerTextReply(deps, webCommentInput("да"))).resolves.toEqual({
      outcome: "skipped_mode",
      mode: "board_only",
    });
    expect(calls.resolveCard).not.toHaveBeenCalled();
    expect(calls.reaskCard).not.toHaveBeenCalled();
  });

  it("reports no card when the owner has nothing pending on the task", async () => {
    const { deps } = stubDeps({ cards: [] });
    await expect(handleOwnerTextReply(deps, webCommentInput("да"))).resolves.toEqual({
      outcome: "no_card",
    });
  });

  it("resolves the freshest card and attributes the owner as the resolver", async () => {
    const cards = [confirmationCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    const { deps, calls } = stubDeps({ cards });
    await expect(
      handleOwnerTextReply(deps, { ...webCommentInput("ок"), runId: "run-1" }),
    ).resolves.toEqual({
      outcome: "resolved",
      interactionId: "ix-1",
      action: "accept",
      status: "accepted",
    });
    expect(calls.resolveCard).toHaveBeenCalledWith({
      card: cards[0],
      action: "accept",
      body: {},
      ownerUserId: OWNER,
      replyCommentId: "comment-1",
      sourceRef: "comment:comment-1",
      runId: "run-1",
    });
  });

  it("asks which question the owner meant when several cards are open", async () => {
    const cards = [
      confirmationCard("ix-new", new Date("2026-01-02T00:00:00Z")),
      questionCard("ix-old", new Date("2026-01-01T00:00:00Z")),
    ];
    const { deps, calls } = stubDeps({ cards });
    await expect(handleOwnerTextReply(deps, webCommentInput("да"))).resolves.toEqual({
      outcome: "asked_which_card",
      interactionIds: ["ix-new", "ix-old"],
    });
    expect(calls.askWhichCard).toHaveBeenCalledTimes(1);
    expect(calls.resolveCard).not.toHaveBeenCalled();
    // One line asks the question; per-card re-ask marks are not even loaded.
    expect(calls.loadReaskMarks).not.toHaveBeenCalled();
  });

  it("records words that decide nothing, re-asks once, and never closes the card", async () => {
    const cards = [confirmationCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    const { deps, calls } = stubDeps({ cards });
    await expect(handleOwnerTextReply(deps, webCommentInput("обсудим завтра"))).resolves.toEqual({
      outcome: "kept_pending",
      interactionId: "ix-1",
      reason: "answered_without_decision",
      reasked: true,
    });
    expect(calls.resolveCard).not.toHaveBeenCalled();
    expect(calls.reaskCard).toHaveBeenCalledWith({
      card: cards[0],
      ownerUserId: OWNER,
      reason: "answered_without_decision",
      text: "обсудим завтра",
      answerKey: "comment-1",
      runId: null,
    });
  });

  it("does not ask the same question twice for one owner answer", async () => {
    const cards = [confirmationCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    const { deps, calls } = stubDeps({ cards, reasked: ["ix-1"] });
    await expect(handleOwnerTextReply(deps, webCommentInput("обсудим завтра"))).resolves.toEqual({
      outcome: "kept_pending",
      interactionId: "ix-1",
      reason: "answered_without_decision",
      reasked: false,
    });
    expect(calls.reaskCard).not.toHaveBeenCalled();
    expect(calls.loadReaskMarks).toHaveBeenCalledWith({
      companyId: COMPANY,
      issueId: ISSUE,
      answerKey: "comment-1",
      cardIds: ["ix-1"],
    });
  });

  it("reports a defect instead of failing the owner's own write", async () => {
    const cards = [confirmationCard("ix-1", new Date("2026-01-01T00:00:00Z"))];
    const { deps } = stubDeps({
      cards,
      resolveCard: async () => {
        throw new Error("resolution service unavailable");
      },
    });
    await expect(handleOwnerTextReply(deps, webCommentInput("да"))).resolves.toEqual({
      outcome: "failed",
      error: "resolution service unavailable",
    });
  });
});

/** The selection query is the only SQL in the module; the fake keeps it honest. */
function fakeIssueCardDb(rows: unknown[]): Pick<Db, "select"> {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Pick<Db, "select">;
}

function issueCardRow(input: {
  id: string;
  createdAt: Date;
  kind?: string;
  payload?: unknown;
  effectiveResolverPolicy?: string | null;
  addresseeUserId?: string | null;
  addresseeAgentId?: string | null;
  conversationAgentId?: string | null;
}) {
  return {
    id: input.id,
    issueId: ISSUE,
    kind: input.kind ?? "request_confirmation",
    payload: input.payload ?? { title: "Deploy the fix" },
    createdAt: input.createdAt,
    effectiveResolverPolicy: input.effectiveResolverPolicy ?? "addressee_only",
    addresseeAgentId: input.addresseeAgentId ?? null,
    addresseeUserId: input.addresseeUserId ?? OWNER,
    identifier: "TASK-1",
    issueTitle: "Deploy the fix",
    assigneeAgentId: "agent-a",
    conversationAgentId: input.conversationAgentId ?? null,
  };
}

describe("listPendingOwnerCardsForIssue", () => {
  it("returns the owner's pending cards of the task, freshest first", async () => {
    const db = fakeIssueCardDb([
      issueCardRow({ id: "ix-old", createdAt: new Date("2026-01-01T00:00:00Z") }),
      issueCardRow({ id: "ix-new", createdAt: new Date("2026-01-02T00:00:00Z") }),
    ]);
    const cards = await listPendingOwnerCardsForIssue(db, {
      companyId: COMPANY,
      issueId: ISSUE,
      ownerUserId: OWNER,
    });
    expect(cards.map((card) => card.interactionId)).toEqual(["ix-new", "ix-old"]);
    expect(planOwnerReply({ text: "да", cards }).kind).toBe("ask_which_card");
  });

  it("ignores cards the owner cannot decide and cards that are not owner decisions", async () => {
    const db = fakeIssueCardDb([
      issueCardRow({ id: "ix-ok", createdAt: new Date("2026-01-01T00:00:00Z") }),
      // addressed to somebody else
      issueCardRow({
        id: "ix-other",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        addresseeUserId: OTHER_USER,
      }),
      // addressed to an agent
      issueCardRow({
        id: "ix-agent",
        createdAt: new Date("2026-01-03T00:00:00Z"),
        addresseeAgentId: "agent-a",
      }),
      // a conversation task routes its own cards
      issueCardRow({
        id: "ix-conversation",
        createdAt: new Date("2026-01-04T00:00:00Z"),
        conversationAgentId: "agent-a",
      }),
      // a governed confirmation is never closed by a chat sentence
      issueCardRow({
        id: "ix-governed",
        createdAt: new Date("2026-01-05T00:00:00Z"),
        payload: { title: "Approve tool call", toolAction: { name: "deploy" } },
      }),
      // not an owner dialogue kind at all
      issueCardRow({ id: "ix-other-kind", createdAt: new Date("2026-01-06T00:00:00Z"), kind: "suggest_tasks" }),
    ]);
    const cards = await listPendingOwnerCardsForIssue(db, {
      companyId: COMPANY,
      issueId: ISSUE,
      ownerUserId: OWNER,
    });
    expect(cards.map((card) => card.interactionId)).toEqual(["ix-ok"]);
    expect(cards[0]?.card.kind).toBe("request_confirmation");
    expect(cards[0]?.ownerUserId).toBe(OWNER);
  });

  it("answers through a card that a human-only policy left without a message binding", async () => {
    // Cards raised before the owner ever got a DM have no explanation binding:
    // the task-level rule closes them exactly like the bound ones.
    const db = fakeIssueCardDb([
      issueCardRow({
        id: "ix-unbound",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        effectiveResolverPolicy: "human_only",
        addresseeUserId: null,
      }),
    ]);
    const cards = await listPendingOwnerCardsForIssue(db, {
      companyId: COMPANY,
      issueId: ISSUE,
      ownerUserId: OWNER,
    });
    expect(cards).toHaveLength(1);
    expect(planOwnerReply({ text: "нет", cards })).toEqual({
      kind: "resolve",
      card: cards[0],
      action: "reject",
      body: {},
    });
  });
});