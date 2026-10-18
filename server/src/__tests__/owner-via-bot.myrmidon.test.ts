// myrmidon(1.6.5-OWNER-VIA-BOT): integration coverage of the owner dialogue.
// In the default delivery mode the owner gets NO card with buttons; the author
// of the decision is woken to explain it, writes ONE message to the owner's
// standing Telegram DM conversation, and the owner's text answer closes the
// interaction as the owner. Fixtures follow owner-telegram-delivery.myrmidon.test.ts.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import {
  OWNER_DELIVERY_SETTINGS_KEY,
  OWNER_MESSAGE_COMMENT_REASON,
  OWNER_MESSAGE_INTERACTION_LABEL,
} from "@paperclipai/shared";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.js";
import { decideWakeAdmission } from "../modules/wake-queue/domain/policy.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { evaluateIssueThreadInteractionResolverAudience } from "../services/issue-thread-interaction-resolution.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import { readOwnerDeliveryMode } from "../myrmidon/owner-delivery/telegram-owner-bindings.js";
import {
  OWNER_EXPLAIN_WAKE_SOURCE,
  isOwnerExplainWake,
} from "../modules/run-dispatch/myrmidon-pending-interaction-wake.js";
import {
  authorizeOwnerReplyResolution,
  buildOwnerViaBotPromptBlock,
  scheduleOwnerExplainWake,
  sendOwnerMessage,
} from "../myrmidon/owner-delivery/owner-message.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("owner decisions via the bot (1.6.5)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-myrmidon-owner-via-bot-${randomUUID()}`,
  );

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-via-bot-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function publicationsForInteraction(companyId: string, interactionId: string) {
    return db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, companyId),
          eq(sql<string>`${chatPublications.payload}->>'interactionId'`, interactionId),
        ),
      );
  }

  async function insertAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function insertRunningRun(companyId: string, agentId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running" });
    return id;
  }

  /**
   * A company with an owner board user, the agent "Bridget", her standing
   * Telegram DM conversation with the owner (live chat binding) and a plain
   * work task owned by that user. Also a second agent that is a stranger to the
   * decisions, and a live run for each agent.
   */
  async function seed() {
    const companyId = randomUUID();
    const boardUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Via bot ${companyId.slice(0, 8)}`,
      issuePrefix: `VB${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    });
    await db
      .insert(authUsers)
      .values({
        id: boardUserId,
        name: "Owner User",
        email: `owner-${boardUserId.slice(0, 8)}@example.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "operator",
    });
    const agentId = await insertAgent(companyId, "Bridget");
    const strangerId = await insertAgent(companyId, "Outsider");

    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `chat:telegram:${endpointId}`,
      name: `telegram ${endpointId}`,
      type: "chat",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "telegram dm",
      uid: `chat-telegram-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
      enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "telegram" as ChatProvider,
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      capabilities: {
        threads: true,
        directMessages: true,
        nativeStreaming: false,
        messageEdits: true,
        messageDeletes: false,
        reactions: true,
        files: true,
        cards: true,
        actions: true,
        modals: false,
        slashCommands: true,
        ephemeralMessages: false,
        proactiveDirectMessages: true,
      },
    });
    const dmResourceId = randomUUID();
    await db.insert(chatEndpointResources).values({
      id: dmResourceId,
      companyId,
      endpointId,
      type: "direct_message",
      providerResourceId: `telegram-dm-${randomUUID()}`,
      label: "Telegram DM",
      enabled: true,
      availability: "available",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [dmIssue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Telegram chat with Bridget",
        assigneeAgentId: agentId,
        conversationAgentId: agentId,
        conversationUserId: telegramConversationUserId(boardUserId),
        conversationState: "waiting",
        status: "in_review",
        createdByUserId: boardUserId,
      })
      .returning();
    const [conversation] = await db
      .insert(chatConversations)
      .values({
        companyId,
        endpointId,
        resourceId: dmResourceId,
        issueId: dmIssue!.id,
        externalConversationId: `telegram-dm-${companyId.slice(0, 8)}`,
        externalThreadId: `telegram-dm-${companyId.slice(0, 8)}:thread`,
        sessionGeneration: 1,
        externalLabel: "Telegram DM",
        isDirectMessage: true,
        state: "active",
        lastActivityAt: new Date(),
      })
      .returning();
    const [workIssue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Owner question about the release",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: boardUserId,
        createdByUserId: boardUserId,
      })
      .returning();
    const runId = await insertRunningRun(companyId, agentId);
    const strangerRunId = await insertRunningRun(companyId, strangerId);
    return {
      companyId,
      agentId,
      strangerId,
      boardUserId,
      endpointId,
      dmIssue: dmIssue!,
      conversation: conversation!,
      workIssue: workIssue!,
      runId,
      strangerRunId,
    };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  function questionCard(fixture: Fixture, resolverPolicy: "human_only" | "anyone" = "human_only") {
    return issueThreadInteractionService(db).create(
      { id: fixture.workIssue.id, companyId: fixture.companyId },
      {
        kind: "ask_user_questions" as const,
        continuationPolicy: "wake_assignee" as const,
        resolverPolicy,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "deploy-window",
              prompt: "Which deploy window?",
              selectionMode: "single" as const,
              allowOther: false,
              options: [
                { id: "morning", label: "Morning" },
                { id: "evening", label: "Evening" },
              ],
            },
          ],
        },
      },
      { agentId: fixture.agentId },
    );
  }

  function confirmationCard(fixture: Fixture) {
    return issueThreadInteractionService(db).create(
      { id: fixture.workIssue.id, companyId: fixture.companyId },
      {
        kind: "request_confirmation" as const,
        continuationPolicy: "wake_assignee" as const,
        resolverPolicy: "human_only" as const,
        payload: {
          version: 1 as const,
          prompt: "Proceed with the deploy?",
          acceptLabel: "Accept",
          rejectLabel: "Reject",
          allowDeclineReason: true,
        },
      },
      { agentId: fixture.agentId },
    );
  }

  /** The owner's answer as the Telegram bridge stores it: a user comment plus an inbound link. */
  async function insertOwnerAnswer(
    fixture: Fixture,
    options: { authorUserId?: string; withInboundLink?: boolean; createdAt?: Date; body?: string } = {},
  ) {
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId: fixture.companyId,
        issueId: fixture.dmIssue.id,
        authorType: "user",
        authorUserId: options.authorUserId ?? fixture.boardUserId,
        body: options.body ?? "Morning, please.",
        createdAt: options.createdAt ?? new Date(Date.now() + 5_000),
        updatedAt: options.createdAt ?? new Date(Date.now() + 5_000),
      })
      .returning();
    if (options.withInboundLink !== false) {
      await db.insert(chatMessageLinks).values({
        companyId: fixture.companyId,
        endpointId: fixture.endpointId,
        conversationId: fixture.conversation.id,
        commentId: comment!.id,
        providerMessageId: `tg-${randomUUID()}`,
        direction: "inbound",
      });
    }
    return comment!;
  }

  async function ownerMessagePublications(fixture: Fixture) {
    return db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, fixture.companyId),
          eq(chatPublications.issueId, fixture.dmIssue.id),
        ),
      );
  }

  describe("no card", () => {
    it("publishes no card with buttons to the owner in the default mode", async () => {
      const fixture = await seed();
      // Nothing is stored: the default applies.
      expect(await readOwnerDeliveryMode(db)).toBe("via_bot");

      const question = await questionCard(fixture);
      const confirmation = await confirmationCard(fixture);

      expect(await publicationsForInteraction(fixture.companyId, question.id)).toEqual([]);
      expect(await publicationsForInteraction(fixture.companyId, confirmation.id)).toEqual([]);
      expect(await ownerMessagePublications(fixture)).toEqual([]);
    });
  });

  describe("wake of the author", () => {
    it("wakes the author on the task with the interaction as context", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);
      const wakeup = vi.fn(async () => undefined);

      const outcome = await scheduleOwnerExplainWake(db, {
        companyId: fixture.companyId,
        issueId: fixture.workIssue.id,
        interaction: question,
        wakeup,
        requestedBy: { actorType: "agent", actorId: fixture.agentId },
      });

      expect(outcome).toBe("woken");
      expect(wakeup).toHaveBeenCalledTimes(1);
      const [agentId, options] = wakeup.mock.calls[0] as unknown as [
        string,
        { idempotencyKey: string; contextSnapshot: Record<string, unknown>; payload: Record<string, unknown> },
      ];
      expect(agentId).toBe(fixture.agentId);
      expect(options.idempotencyKey).toBe(`owner-explain:${question.id}`);
      expect(options.payload.issueId).toBe(fixture.workIssue.id);
      expect(options.contextSnapshot).toMatchObject({
        issueId: fixture.workIssue.id,
        interactionId: question.id,
        source: OWNER_EXPLAIN_WAKE_SOURCE,
        ownerExplainInteractionId: question.id,
      });

      // The run-dispatch gate recognises exactly this wake, for the author only.
      expect(
        await isOwnerExplainWake(db, {
          companyId: fixture.companyId,
          issueId: fixture.workIssue.id,
          agentId: fixture.agentId,
          contextSnapshot: options.contextSnapshot,
        }),
      ).toBe(true);
      expect(
        await isOwnerExplainWake(db, {
          companyId: fixture.companyId,
          issueId: fixture.workIssue.id,
          agentId: fixture.strangerId,
          contextSnapshot: options.contextSnapshot,
        }),
      ).toBe(false);

      // The run prompt carries the decision: text, options, id and the order to explain it.
      const block = await buildOwnerViaBotPromptBlock(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        issue: fixture.workIssue,
        ownerExplainInteractionId: question.id,
        wakeCommentId: null,
      });
      expect(block).toContain(question.id);
      expect(block).toContain("Which deploy window?");
      expect(block).toContain("morning = Morning");
      expect(block).toContain("myrmidonMessageOwner");
    });

    it("does not wake for operational cards, agent-addressed cards, other modes or without a DM", async () => {
      const fixture = await seed();
      const wakeup = vi.fn(async () => undefined);
      const wake = (interaction: Awaited<ReturnType<typeof questionCard>>) =>
        scheduleOwnerExplainWake(db, {
          companyId: fixture.companyId,
          issueId: fixture.workIssue.id,
          interaction,
          wakeup,
          requestedBy: { actorType: "agent", actorId: fixture.agentId },
        });

      // An operational card (anyone can resolve it) is not an owner decision.
      expect(await wake(await questionCard(fixture, "anyone"))).toBe("skipped_not_owner_decision");

      // A card addressed to another agent is traffic between agents.
      const otherAgentId = await insertAgent(fixture.companyId, "Agent B");
      const agentAddressed = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "request_confirmation" as const,
          continuationPolicy: "wake_assignee" as const,
          resolverPolicy: "not_creator" as const,
          addresseeAgentId: otherAgentId,
          payload: {
            version: 1 as const,
            prompt: "Review this?",
            acceptLabel: "Accept",
            rejectLabel: "Reject",
            allowDeclineReason: true,
          },
        },
        { agentId: fixture.agentId },
      );
      expect(await wake(agentAddressed)).toBe("skipped_not_owner_decision");

      // Another delivery mode keeps the cards, so no explain wake.
      const settings = instanceSettingsService(db);
      await settings.updateGeneral({ [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" } });
      try {
        expect(await wake(await confirmationCard(fixture))).toBe("skipped_mode");
      } finally {
        await settings.updateGeneral({ [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "via_bot" } });
      }

      // The owner has no live direct chat with the author: no channel to explain in.
      await db
        .update(chatConversations)
        .set({ state: "completed" })
        .where(eq(chatConversations.id, fixture.conversation.id));
      expect(await wake(await questionCard(fixture))).toBe("skipped_no_owner_dm");

      expect(wakeup).not.toHaveBeenCalled();
    });
  });

  describe("outgoing message", () => {
    it("delivers one message to the owner's DM conversation, bound to the interaction", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);

      const result = await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [question.id],
        text: "Please choose the deploy window: morning or evening. I recommend morning.",
      });

      expect(result.conversationIssueId).toBe(fixture.dmIssue.id);
      const publications = await ownerMessagePublications(fixture);
      expect(publications).toHaveLength(1);
      expect(publications[0]!.id).toBe(result.publicationId);
      expect(publications[0]!.endpointId).toBe(fixture.endpointId);
      expect(publications[0]!.conversationId).toBe(fixture.conversation.id);
      expect(publications[0]!.state).toBe("pending");
      expect(publications[0]!.commentId).toBe(result.commentId);
      expect((publications[0]!.payload as { text?: string }).text).toContain("deploy window");
      // Plain message: no card, no buttons.
      expect((publications[0]!.payload as { card?: unknown }).card).toBeUndefined();

      // The binding: an agent comment in the DM issue naming the interaction.
      const [comment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, result.commentId));
      expect(comment!.authorAgentId).toBe(fixture.agentId);
      expect(comment!.issueId).toBe(fixture.dmIssue.id);
      expect(comment!.metadata?.authorizationReason).toBe(OWNER_MESSAGE_COMMENT_REASON);
      expect(comment!.metadata?.sections[0]?.rows).toEqual([
        { type: "key_value", label: OWNER_MESSAGE_INTERACTION_LABEL, value: question.id },
      ]);
    });

    it("allows one message per question", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);
      const send = () =>
        sendOwnerMessage(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runId: fixture.runId,
          interactionIds: [question.id],
          text: "Which window do you want?",
        });
      await send();
      await expect(send()).rejects.toMatchObject({
        status: 409,
        details: { code: "already_explained", interactionIds: [question.id] },
      });
      expect(await ownerMessagePublications(fixture)).toHaveLength(1);
    });

    it("turns several open questions into one summary", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);
      const confirmation = await confirmationCard(fixture);

      // Explaining only one of two open decisions is refused and names the other.
      await expect(
        sendOwnerMessage(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runId: fixture.runId,
          interactionIds: [question.id],
          text: "Question one only.",
        }),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          code: "summary_required",
          missing: [expect.objectContaining({ interactionId: confirmation.id })],
        },
      });
      expect(await ownerMessagePublications(fixture)).toHaveLength(0);

      // One message covering both is the only message that goes out.
      const result = await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [question.id, confirmation.id],
        text: "Two decisions: 1) deploy window, 2) go or no-go.",
      });
      expect(result.interactionIds).toEqual([question.id, confirmation.id]);
      expect(await ownerMessagePublications(fixture)).toHaveLength(1);
    });

    it("does not let a stranger agent write to the owner", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);

      // Another agent of the company, calling from its own live run.
      await expect(
        sendOwnerMessage(db, {
          companyId: fixture.companyId,
          agentId: fixture.strangerId,
          runId: fixture.strangerRunId,
          interactionIds: [question.id],
          text: "Hello owner, this is not my decision.",
        }),
      ).rejects.toMatchObject({
        status: 403,
        details: { code: "not_author_of_open_owner_decision" },
      });

      // The author itself, but from a run that belongs to someone else.
      await expect(
        sendOwnerMessage(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runId: fixture.strangerRunId,
          interactionIds: [question.id],
          text: "Borrowed run.",
        }),
      ).rejects.toMatchObject({ status: 403 });

      // A decision that is already closed cannot be written about.
      await issueThreadInteractionService(db).answerQuestions(
        fixture.workIssue,
        question.id,
        { answers: [{ questionId: "deploy-window", optionIds: ["morning"] }] },
        { userId: fixture.boardUserId },
      );
      await expect(
        sendOwnerMessage(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runId: fixture.runId,
          interactionIds: [question.id],
          text: "Too late.",
        }),
      ).rejects.toMatchObject({ status: 403 });

      expect(await ownerMessagePublications(fixture)).toHaveLength(0);
    });
  });

  describe("the owner's text answer", () => {
    it("reaches the agent marked as an answer to the interaction", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);
      await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [question.id],
        text: "Which window do you want?",
      });
      const answer = await insertOwnerAnswer(fixture);

      const block = await buildOwnerViaBotPromptBlock(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        issue: fixture.dmIssue,
        ownerExplainInteractionId: null,
        wakeCommentId: answer.id,
      });
      expect(block).toContain(question.id);
      expect(block).toContain(answer.id);
      expect(block).toContain("Which deploy window?");
      expect(block).toContain("myrmidonResolveInteractionByOwnerReply");

      // A turn woken by something that is not the owner's message gets no such note.
      const strangerComment = await insertOwnerAnswer(fixture, { authorUserId: randomUUID() });
      expect(
        await buildOwnerViaBotPromptBlock(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          issue: fixture.dmIssue,
          ownerExplainInteractionId: null,
          wakeCommentId: strangerComment.id,
        }),
      ).toBe("");
    });

    it("closes a human-only question as the owner, not as the agent", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);
      await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [question.id],
        text: "Which window do you want?",
      });
      const answer = await insertOwnerAnswer(fixture);

      // The agent itself is not an allowed resolver of a human-only card ...
      const asAgent = evaluateIssueThreadInteractionResolverAudience({
        actor: { type: "agent", agentId: fixture.agentId, runId: fixture.runId },
        interaction: question,
      });
      expect(asAgent).toMatchObject({ allowed: false, code: "interaction_human_only" });

      // ... so the guard proves the owner's answer and names the OWNER as the actor.
      const authorization = await authorizeOwnerReplyResolution(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        resolution: {
          interactionId: question.id,
          ownerReplyCommentId: answer.id,
          action: "respond",
        },
      });
      expect(authorization).toMatchObject({
        ownerUserId: fixture.boardUserId,
        issueId: fixture.workIssue.id,
        interactionId: question.id,
        action: "respond",
        conversationIssueId: fixture.dmIssue.id,
      });
      expect(
        evaluateIssueThreadInteractionResolverAudience({
          actor: { type: "user", userId: authorization.ownerUserId },
          interaction: question,
        }),
      ).toMatchObject({ allowed: true });

      // The ordinary respond path, run as the owner the guard returned.
      const resolved = await issueThreadInteractionService(db).answerQuestions(
        fixture.workIssue,
        question.id,
        { answers: [{ questionId: "deploy-window", optionIds: ["morning"] }] },
        { userId: authorization.ownerUserId },
      );
      expect(resolved.status).toBe("answered");
      expect(resolved.resolvedByUserId).toBe(fixture.boardUserId);
      expect(resolved.resolvedByAgentId ?? null).toBeNull();
    });

    it("closes a human-only confirmation as the owner", async () => {
      const fixture = await seed();
      const confirmation = await confirmationCard(fixture);
      await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [confirmation.id],
        text: "Shall I proceed with the deploy?",
      });
      const answer = await insertOwnerAnswer(fixture, { body: "Yes, go." });

      const authorization = await authorizeOwnerReplyResolution(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        resolution: {
          interactionId: confirmation.id,
          ownerReplyCommentId: answer.id,
          action: "accept",
        },
      });
      const { interaction } = await issueThreadInteractionService(db).acceptInteraction(
        fixture.workIssue,
        confirmation.id,
        {},
        { userId: authorization.ownerUserId },
      );
      expect(interaction.status).toBe("accepted");
      expect(interaction.resolvedByUserId).toBe(fixture.boardUserId);
      expect(interaction.resolvedByAgentId ?? null).toBeNull();
    });

    it("refuses to close without the owner's explicit answer in this binding", async () => {
      const fixture = await seed();
      const question = await questionCard(fixture);
      const resolve = (ownerReplyCommentId: string, action: "respond" | "accept" = "respond") =>
        authorizeOwnerReplyResolution(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runId: fixture.runId,
          resolution: { interactionId: question.id, ownerReplyCommentId, action },
        });

      // No message to the owner is bound to the interaction yet.
      await expect(resolve(randomUUID())).rejects.toMatchObject({
        status: 409,
        details: { code: "not_explained" },
      });

      const message = await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [question.id],
        text: "Which window do you want?",
      });

      // Silence: no answer at all, or the agent's own comment passed off as one.
      await expect(resolve(randomUUID())).rejects.toMatchObject({ status: 403, details: { code: "no_owner_reply" } });
      await expect(resolve(message.commentId)).rejects.toMatchObject({ status: 403 });
      // Somebody else's words, or text that did not arrive through the chat.
      const foreign = await insertOwnerAnswer(fixture, { authorUserId: randomUUID() });
      await expect(resolve(foreign.id)).rejects.toMatchObject({ status: 403 });
      const unlinked = await insertOwnerAnswer(fixture, { withInboundLink: false });
      await expect(resolve(unlinked.id)).rejects.toMatchObject({ status: 403 });
      // An answer that predates the explanation answers nothing.
      const early = await insertOwnerAnswer(fixture, { createdAt: new Date(Date.now() - 3_600_000) });
      await expect(resolve(early.id)).rejects.toMatchObject({ status: 403 });
      // A confirmation action cannot close a question form.
      const good = await insertOwnerAnswer(fixture);
      await expect(resolve(good.id, "accept")).rejects.toMatchObject({
        status: 422,
        details: { code: "action_kind_mismatch" },
      });
      // A stranger agent cannot close it with the owner's real answer either.
      await expect(
        authorizeOwnerReplyResolution(db, {
          companyId: fixture.companyId,
          agentId: fixture.strangerId,
          runId: fixture.strangerRunId,
          resolution: { interactionId: question.id, ownerReplyCommentId: good.id, action: "respond" },
        }),
      ).rejects.toMatchObject({ status: 403 });

      // The real answer passes.
      await expect(resolve(good.id)).resolves.toMatchObject({ ownerUserId: fixture.boardUserId });
    });
  });

  describe("who the owner is (1.6.5-OWNER-FALLBACK)", () => {
    async function insertBoardUser(companyId: string, membershipRole: string | null) {
      const userId = randomUUID();
      await db.insert(authUsers).values({
        id: userId,
        name: "Board User",
        email: `user-${userId.slice(0, 8)}@example.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole,
      });
      return userId;
    }

    /** A standing Telegram DM of `userId` with the fixture's agent, on the fixture's endpoint. */
    async function addDm(fixture: Fixture, userId: string) {
      const resourceId = randomUUID();
      await db.insert(chatEndpointResources).values({
        id: resourceId,
        companyId: fixture.companyId,
        endpointId: fixture.endpointId,
        type: "direct_message",
        providerResourceId: `telegram-dm-${randomUUID()}`,
        label: "Telegram DM",
        enabled: true,
        availability: "available",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const [dmIssue] = await db
        .insert(issues)
        .values({
          companyId: fixture.companyId,
          title: "Telegram chat with Bridget (second)",
          assigneeAgentId: fixture.agentId,
          conversationAgentId: fixture.agentId,
          conversationUserId: telegramConversationUserId(userId),
          conversationState: "waiting",
          status: "in_review",
          createdByUserId: userId,
        })
        .returning();
      const [conversation] = await db
        .insert(chatConversations)
        .values({
          companyId: fixture.companyId,
          endpointId: fixture.endpointId,
          resourceId,
          issueId: dmIssue!.id,
          externalConversationId: `telegram-dm-${randomUUID()}`,
          externalThreadId: `telegram-dm-${randomUUID()}:thread`,
          sessionGeneration: 1,
          externalLabel: "Telegram DM",
          isDirectMessage: true,
          state: "active",
          lastActivityAt: new Date(),
        })
        .returning();
      return { dmIssue: dmIssue!, conversation: conversation! };
    }

    async function makeOwner(fixture: Fixture) {
      await db
        .update(companyMemberships)
        .set({ membershipRole: "owner" })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalId, fixture.boardUserId),
          ),
        );
    }

    async function taskOf(
      fixture: Fixture,
      values: { responsibleUserId?: string | null; createdByUserId?: string | null; createdByAgentId?: string | null },
    ) {
      const [row] = await db
        .insert(issues)
        .values({
          companyId: fixture.companyId,
          title: "Task from the board",
          status: "in_progress",
          assigneeAgentId: fixture.agentId,
          ...values,
        })
        .returning();
      return row!;
    }

    function cardOn(
      fixture: Fixture,
      issue: { id: string },
      extra: { resolverPolicy?: "human_only" | "anyone"; addresseeUserId?: string } = {},
    ) {
      return issueThreadInteractionService(db).create(
        { id: issue.id, companyId: fixture.companyId },
        {
          kind: "request_confirmation" as const,
          continuationPolicy: "wake_assignee" as const,
          resolverPolicy: extra.resolverPolicy ?? ("human_only" as const),
          ...(extra.addresseeUserId ? { addresseeUserId: extra.addresseeUserId } : {}),
          payload: {
            version: 1 as const,
            prompt: "Proceed?",
            acceptLabel: "Accept",
            rejectLabel: "Reject",
            allowDeclineReason: true,
          },
        },
        { agentId: fixture.agentId },
      );
    }

    async function wakeFor(fixture: Fixture, issue: { id: string }, interaction: Awaited<ReturnType<typeof cardOn>>) {
      const wakeup = vi.fn(async () => undefined);
      const outcome = await scheduleOwnerExplainWake(db, {
        companyId: fixture.companyId,
        issueId: issue.id,
        interaction,
        wakeup,
        requestedBy: { actorType: "agent", actorId: fixture.agentId },
      });
      return { outcome, wakeup };
    }

    it("a task created by an agent with no responsible user goes to the company owner with a DM", async () => {
      const fixture = await seed();
      await makeOwner(fixture);
      const task = await taskOf(fixture, { createdByAgentId: fixture.strangerId });
      const card = await cardOn(fixture, task);

      const { outcome, wakeup } = await wakeFor(fixture, task, card);
      expect(outcome).toBe("woken");
      expect(wakeup).toHaveBeenCalledTimes(1);

      // The message, the owner's answer and the closing guard all name the same owner.
      await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [card.id],
        text: "Please confirm: proceed with the change? I recommend yes.",
      });
      const answer = await insertOwnerAnswer(fixture);
      await expect(
        authorizeOwnerReplyResolution(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runId: fixture.runId,
          resolution: { interactionId: card.id, ownerReplyCommentId: answer.id, action: "accept" },
        }),
      ).resolves.toMatchObject({ ownerUserId: fixture.boardUserId, issueId: task.id });
    });

    it("a responsible user without a DM falls back to the company owner", async () => {
      const fixture = await seed();
      await makeOwner(fixture);
      const noDmUser = await insertBoardUser(fixture.companyId, "operator");
      const task = await taskOf(fixture, { responsibleUserId: noDmUser, createdByUserId: noDmUser });
      const card = await cardOn(fixture, task);

      const { outcome } = await wakeFor(fixture, task, card);
      expect(outcome).toBe("woken");

      await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [card.id],
        text: "Please confirm: proceed with the change? I recommend yes.",
      });
      const publications = await ownerMessagePublications(fixture);
      expect(publications).toHaveLength(1);
      expect(publications[0]!.conversationId).toBe(fixture.conversation.id);

      // The answer of the person without a DM does not close it; the owner's does.
      const answer = await insertOwnerAnswer(fixture);
      await expect(
        authorizeOwnerReplyResolution(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          runId: fixture.runId,
          resolution: { interactionId: card.id, ownerReplyCommentId: answer.id, action: "accept" },
        }),
      ).resolves.toMatchObject({ ownerUserId: fixture.boardUserId });
    });

    it("a question addressed to a specific person goes to that person", async () => {
      const fixture = await seed();
      await makeOwner(fixture);
      const addresseeUserId = await insertBoardUser(fixture.companyId, "operator");
      const addresseeDm = await addDm(fixture, addresseeUserId);
      const task = await taskOf(fixture, { createdByAgentId: fixture.strangerId });
      const card = await cardOn(fixture, task, { resolverPolicy: "anyone", addresseeUserId });

      const { outcome } = await wakeFor(fixture, task, card);
      expect(outcome).toBe("woken");

      await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [card.id],
        text: "Please confirm: proceed with the change? I recommend yes.",
      });
      const toAddressee = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(chatPublications.issueId, addresseeDm.dmIssue.id),
          ),
        );
      expect(toAddressee).toHaveLength(1);
      expect(await ownerMessagePublications(fixture)).toEqual([]);
    });

    it("the explain wake waits behind the author's running run instead of merging into it", async () => {
      const fixture = await seed();
      const card = await cardOn(fixture, fixture.workIssue);
      const { wakeup } = await wakeFor(fixture, fixture.workIssue, card);
      const [, options] = wakeup.mock.calls[0] as unknown as [string, { contextSnapshot: Record<string, unknown> }];
      // The author's own run is running on the task: the wake must defer, not coalesce.
      expect(
        shouldQueueFollowupForRunningIssueWake({ contextSnapshot: options.contextSnapshot, wakeCommentId: null }),
      ).toBe(true);
      expect(
        decideWakeAdmission({
          allowRunCoalescing: true,
          sameDurableActor: true,
          isSameExecutionAgent: true,
          shouldDeferFollowupWake: false,
          shouldQueueFollowupForRunningWake: true,
          availableActiveExecutionRunPresent: true,
        }),
      ).toEqual({ kind: "defer" });
      // Other pending-interaction wakes keep merging into a running run.
      expect(
        shouldQueueFollowupForRunningIssueWake({
          contextSnapshot: { wakeReason: "interaction_pending" },
          wakeCommentId: null,
        }),
      ).toBe(false);

      // The deferred run carries the explanation block.
      const block = await buildOwnerViaBotPromptBlock(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        issue: fixture.workIssue,
        ownerExplainInteractionId: card.id,
        wakeCommentId: null,
      });
      expect(block).toContain(card.id);
    });

    it("explaining in the same run cancels the deferred wake and empties its block", async () => {
      const fixture = await seed();
      const card = await cardOn(fixture, fixture.workIssue);
      const [deferred] = await db
        .insert(agentWakeupRequests)
        .values({
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          source: "automation",
          reason: "issue_execution_deferred",
          status: "deferred_issue_execution",
          idempotencyKey: `owner-explain:${card.id}`,
        })
        .returning();

      await sendOwnerMessage(db, {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        interactionIds: [card.id],
        text: "Please confirm: proceed with the change? I recommend yes.",
      });

      const [after] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferred!.id));
      expect(after!.status).toBe("cancelled");
      // Even if such a wake ran, nothing is left to explain.
      expect(
        await buildOwnerViaBotPromptBlock(db, {
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          issue: fixture.workIssue,
          ownerExplainInteractionId: card.id,
          wakeCommentId: null,
        }),
      ).toBe("");
    });

    it("a question addressed to a person without a DM does not go to the company owner", async () => {
      const fixture = await seed();
      await makeOwner(fixture);
      const addresseeUserId = await insertBoardUser(fixture.companyId, "operator");
      const task = await taskOf(fixture, { responsibleUserId: fixture.boardUserId });
      const card = await cardOn(fixture, task, { resolverPolicy: "anyone", addresseeUserId });

      const { outcome, wakeup } = await wakeFor(fixture, task, card);
      expect(outcome).toBe("skipped_no_owner_dm");
      expect(wakeup).not.toHaveBeenCalled();
      expect(await ownerMessagePublications(fixture)).toEqual([]);
    });

    it("stays on the board when nobody has a DM with the author", async () => {
      const fixture = await seed();
      // The company owner exists but has no DM with the author: board only.
      const noDmUser = await insertBoardUser(fixture.companyId, "owner");
      const task = await taskOf(fixture, { responsibleUserId: noDmUser });
      const card = await cardOn(fixture, task);

      const { outcome, wakeup } = await wakeFor(fixture, task, card);
      expect(outcome).toBe("skipped_no_owner_dm");
      expect(wakeup).not.toHaveBeenCalled();
    });
  });
});
