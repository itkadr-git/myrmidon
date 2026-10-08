// myrmidon(1.6.5-F21-AUTOCLOSE): coverage for the owner-decision autoclose —
// the third part of F-21 (the lead's split): an owner's own message in the
// task's chat closes that task's open owner decision without an agent run,
// which is the only way a card raised before the via_bot mode can be closed by
// the owner's words.
//
// The classifier block is pure and always runs; the resolution block needs a
// real database (embedded Postgres) because it exercises the same service calls
// the board's accept/respond routes make.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  createDb,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import {
  autoCloseOwnerDecisionOnOwnerComment,
  classifyOwnerChatReplyByFreeText,
  type OwnerChatReplyClassifier,
} from "./owner-autoclose.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describe("owner chat reply classification (F-21 autoclose)", () => {
  const freeTextQuestion = (overrides: Record<string, unknown> = {}) => ({
    version: 1 as const,
    questions: [
      {
        id: "q1",
        prompt: "When should we ship?",
        selectionMode: "single" as const,
        allowOther: true,
        options: [{ id: "opt-a", label: "Today" }],
        ...overrides,
      },
    ],
  });

  it("answers a single question the card lets the owner answer in words", () => {
    const resolution = classifyOwnerChatReplyByFreeText({
      kind: "ask_user_questions",
      payload: freeTextQuestion(),
      replyText: "  Пятница, после обеда  ",
    });
    expect(resolution).toEqual({
      action: "respond",
      answers: [{ questionId: "q1", optionIds: [], otherText: "Пятница, после обеда" }],
      summaryMarkdown: "Пятница, после обеда",
    });
  });

  it("carries the option a typed answer was typed into", () => {
    const resolution = classifyOwnerChatReplyByFreeText({
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [
          {
            id: "q1",
            prompt: "How?",
            selectionMode: "single",
            options: [{ id: "opt-own", label: "I'll describe it", freeText: true }],
          },
        ],
      },
      replyText: "через фича-флаг",
    });
    expect(resolution).toEqual({
      action: "respond",
      answers: [
        { questionId: "q1", optionIds: ["opt-own"], otherText: "через фича-флаг" },
      ],
      summaryMarkdown: "через фича-флаг",
    });
  });

  it("refuses a closed select: '2)' must pick option 2 (the parser's call)", () => {
    expect(
      classifyOwnerChatReplyByFreeText({
        kind: "ask_user_questions",
        payload: freeTextQuestion({ allowOther: false, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
        replyText: "2) да",
      }),
    ).toBeNull();
  });

  it("refuses a card with several questions", () => {
    expect(
      classifyOwnerChatReplyByFreeText({
        kind: "ask_user_questions",
        payload: {
          version: 1,
          questions: [
            { id: "q1", prompt: "A?", selectionMode: "single", allowOther: true, options: [] },
            { id: "q2", prompt: "B?", selectionMode: "single", allowOther: true, options: [] },
          ],
        },
        replyText: "да",
      }),
    ).toBeNull();
  });

  it("refuses a worded confirmation and an empty reply", () => {
    expect(
      classifyOwnerChatReplyByFreeText({
        kind: "request_confirmation",
        payload: { version: 1, prompt: "Ship it?" },
        replyText: "да",
      }),
    ).toBeNull();
    expect(
      classifyOwnerChatReplyByFreeText({
        kind: "ask_user_questions",
        payload: freeTextQuestion(),
        replyText: "   ",
      }),
    ).toBeNull();
  });
});

describeEmbeddedPostgres("owner decision autoclose (F-21)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-f21-owner-autoclose-",
    );
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const otherUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Autoclose co ${companyId.slice(0, 6)}`,
      issuePrefix: `AC${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    });
    await db.insert(authUsers).values(
      [ownerUserId, otherUserId].map((id) => ({
        id,
        name: `User ${id.slice(0, 6)}`,
        email: `user-${id.slice(0, 8)}@example.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Task with an owner decision",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: ownerUserId,
        createdByUserId: ownerUserId,
      })
      .returning();
    return { companyId, agentId, ownerUserId, otherUserId, issue: issue! };
  }

  function cardPayload(overrides: Record<string, unknown> = {}) {
    return {
      version: 1 as const,
      questions: [
        {
          id: "q1",
          prompt: "When should we ship?",
          selectionMode: "single" as const,
          allowOther: true,
          options: [{ id: "opt-a", label: "Today" }],
          ...overrides,
        },
      ],
    };
  }

  async function raiseCard(
    fixture: Awaited<ReturnType<typeof seed>>,
    input: {
      payload?: unknown;
      kind?: "ask_user_questions" | "request_confirmation";
      addresseeUserId?: string | null;
      resolverPolicy?: "human_only" | "anyone";
      continuationPolicy?: "wake_assignee" | "none";
    } = {},
  ) {
    const service = issueThreadInteractionService(db);
    return await service.create(
      { id: fixture.issue.id, companyId: fixture.companyId },
      {
        kind: input.kind ?? ("ask_user_questions" as const),
        continuationPolicy: input.continuationPolicy ?? ("wake_assignee" as const),
        resolverPolicy: input.resolverPolicy ?? ("human_only" as const),
        ...(input.addresseeUserId === null
          ? {}
          : { addresseeUserId: input.addresseeUserId ?? fixture.ownerUserId }),
        idempotencyKey: `f21-autoclose-${randomUUID()}`,
        payload: (input.payload ?? cardPayload()) as never,
      },
      { agentId: fixture.agentId },
    );
  }

  async function readInteraction(interactionId: string) {
    const [row] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    return row!;
  }

  const ownerReply = (
    fixture: Awaited<ReturnType<typeof seed>>,
    overrides: Partial<Parameters<typeof autoCloseOwnerDecisionOnOwnerComment>[0]> = {},
  ) =>
    autoCloseOwnerDecisionOnOwnerComment({
      db,
      companyId: fixture.companyId,
      issueId: fixture.issue.id,
      ownerUserId: fixture.ownerUserId,
      commentId: randomUUID(),
      replyText: "Пятница, после обеда",
      commentCreatedAt: new Date(Date.now() + 1000),
      deps: {},
      ...overrides,
    });

  it("closes the card the owner's message answers, without an agent run", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture);

    const outcome = await ownerReply(fixture);

    expect(outcome).toMatchObject({
      outcome: "resolved",
      interactionId: card.id,
      action: "respond",
      interactionStatus: "answered",
    });
    const row = await readInteraction(card.id);
    expect(row.status).toBe("answered");
    expect(row.resolvedByUserId).toBe(fixture.ownerUserId);
    expect(row.result).toMatchObject({
      answers: [
        { questionId: "q1", optionIds: [], otherText: "Пятница, после обеда" },
      ],
    });

    // The agent's continuation is queued like after a board click — and nothing
    // in this path needed the agent to run.
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, fixture.agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]!.payload).toMatchObject({
      issueId: fixture.issue.id,
      interactionId: card.id,
      interactionStatus: "answered",
    });
  });

  it("resolves a card that names no human through the task's owner", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture, { addresseeUserId: null });

    const outcome = await ownerReply(fixture);

    expect(outcome).toMatchObject({ outcome: "resolved", interactionId: card.id });
    expect((await readInteraction(card.id)).status).toBe("answered");
  });

  it("leaves a closed select to the owner-reply parser", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture, {
      payload: cardPayload({
        allowOther: false,
        options: [
          { id: "opt-a", label: "Today" },
          { id: "opt-b", label: "Tomorrow" },
        ],
      }),
    });

    expect(await ownerReply(fixture, { replyText: "2) да" })).toEqual({
      outcome: "skipped",
      reason: "unmappable_reply",
    });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("leaves a worded confirmation to the parser", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?" },
    });

    expect(await ownerReply(fixture, { replyText: "да" })).toEqual({
      outcome: "skipped",
      reason: "unmappable_reply",
    });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("refuses two open decisions of the same writer", async () => {
    const fixture = await seed();
    // One open decision per kind per issue: a second card of the SAME kind
    // supersedes the first, so two open decisions of one writer means two
    // kinds — exactly the case a single sentence must not split.
    const question = await raiseCard(fixture);
    const confirmation = await raiseCard(fixture, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?" },
    });

    expect(question.id).not.toBe(confirmation.id);
    expect((await readInteraction(question.id)).status).toBe("pending");
    expect((await readInteraction(confirmation.id)).status).toBe("pending");
    expect(await ownerReply(fixture)).toEqual({
      outcome: "skipped",
      reason: "ambiguous_decisions",
    });
    expect((await readInteraction(question.id)).status).toBe("pending");
    expect((await readInteraction(confirmation.id)).status).toBe("pending");
  });

  it("refuses a reply that is not the card's owner", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture);

    expect(
      await ownerReply(fixture, { ownerUserId: fixture.otherUserId }),
    ).toEqual({ outcome: "skipped", reason: "not_the_owner" });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("refuses a comment written before the card", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture);

    expect(
      await ownerReply(fixture, { commentCreatedAt: new Date(Date.now() - 60_000) }),
    ).toEqual({ outcome: "skipped", reason: "reply_not_after_decision" });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("refuses a quarantined comment origin", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture);

    expect(
      await ownerReply(fixture, { commentSourceTrust: "low_trust_review" }),
    ).toEqual({ outcome: "skipped", reason: "reply_not_attributable" });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("never closes a governed card from a chat sentence", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Merge it?",
        toolAction: {
          version: 1,
          actionRequestId: randomUUID(),
          invocationId: randomUUID(),
          toolName: "repo.merge_pr",
          toolDisplayName: "Merge pull request",
          connectionId: null,
          applicationId: null,
          appDisplayName: null,
          risk: "write",
          previewMarkdown: "Merge pull request 1",
          argumentsSummaryJson: "{}",
          argumentsHash: "fixture-hash",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    });

    expect(await ownerReply(fixture, { replyText: "да" })).toEqual({
      outcome: "skipped",
      reason: "governed_payload",
    });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("ignores a card that hangs on another issue", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture);
    const [otherIssue] = await db
      .insert(issues)
      .values({
        companyId: fixture.companyId,
        title: "Unrelated task",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: fixture.agentId,
      })
      .returning();

    expect(
      await ownerReply(fixture, { issueId: otherIssue!.id }),
    ).toEqual({ outcome: "skipped", reason: "no_pending_decision" });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("ignores a conversation issue of the owner's chat", async () => {
    const fixture = await seed();
    const [conversationIssue] = await db
      .insert(issues)
      .values({
        companyId: fixture.companyId,
        title: "Telegram chat with Agent",
        assigneeAgentId: fixture.agentId,
        conversationAgentId: fixture.agentId,
        conversationUserId: `telegram:${fixture.ownerUserId}`,
        conversationState: "waiting",
        status: "in_progress",
      })
      .returning();
    const service = issueThreadInteractionService(db);
    const card = await service.create(
      { id: conversationIssue!.id, companyId: fixture.companyId },
      {
        kind: "ask_user_questions" as const,
        continuationPolicy: "wake_assignee" as const,
        resolverPolicy: "human_only" as const,
        addresseeUserId: fixture.ownerUserId,
        idempotencyKey: `f21-autoclose-${randomUUID()}`,
        payload: cardPayload() as never,
      },
      { agentId: fixture.agentId },
    );

    expect(
      await ownerReply(fixture, { issueId: conversationIssue!.id }),
    ).toEqual({ outcome: "skipped", reason: "no_pending_decision" });
    expect((await readInteraction(card.id)).status).toBe("pending");
  });

  it("closes through the accept half of the seam when a classifier decides it", async () => {
    const fixture = await seed();
    const card = await raiseCard(fixture, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?" },
    });
    const confirmingClassifier: OwnerChatReplyClassifier = () => ({
      action: "accept",
    });

    const outcome = await ownerReply(fixture, {
      replyText: "да",
      deps: { classifyReply: confirmingClassifier },
    });

    expect(outcome).toMatchObject({
      outcome: "resolved",
      interactionId: card.id,
      action: "accept",
      interactionStatus: "accepted",
      classifier: "custom",
    });
    expect((await readInteraction(card.id)).status).toBe("accepted");
  });
});