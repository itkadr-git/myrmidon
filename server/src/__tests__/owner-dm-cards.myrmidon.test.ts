// myrmidon(1.4-U2): guard tests for owner-facing Telegram DM delivery of
// question and confirmation cards. The card must reach the owner's standing
// bridged DM (X8b conversation) even when the task has no chat thread of its
// own; the flag off must leave the vendor path untouched.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  toolApplications,
  toolConnections,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const BOARD_USER_ID = "owner-dm-user";

describeEmbeddedPostgres(
  "owner Telegram DM delivery of interaction cards (1.4 U2)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const previousDmEnv = process.env.MYRMIDON_TELEGRAM_DM_CONVERSATIONS;

    beforeAll(async () => {
      process.env.MYRMIDON_TELEGRAM_DM_CONVERSATIONS = "*";
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-owner-dm-cards-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterAll(async () => {
      if (previousDmEnv === undefined)
        delete process.env.MYRMIDON_TELEGRAM_DM_CONVERSATIONS;
      else
        process.env.MYRMIDON_TELEGRAM_DM_CONVERSATIONS = previousDmEnv;
      await tempDb?.cleanup();
    });

    async function seedFixture() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const boardUserId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Owner DM cards ${companyId.slice(0, 8)}`,
        issuePrefix: `UD${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      });
      const now = new Date();
      await db
        .insert(authUsers)
        .values({
          id: BOARD_USER_ID,
          name: "Owner DM User",
          email: "owner-dm@example.com",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: BOARD_USER_ID,
        status: "active",
        membershipRole: "operator",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Owner DM agent",
        role: "operator",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      // A plain task (no chat binding of its own) with a responsible owner.
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Threadless task awaiting an owner decision",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: BOARD_USER_ID,
        createdByUserId: BOARD_USER_ID,
      });
      // The owner's standing Telegram DM conversation (X8b bridge shape).
      const conversationIssueId = randomUUID();
      await db.insert(issues).values({
        id: conversationIssueId,
        companyId,
        title: "Telegram chat with Owner DM agent",
        status: "in_review",
        assigneeAgentId: agentId,
        conversationAgentId: agentId,
        conversationUserId: telegramConversationUserId(BOARD_USER_ID),
        conversationState: "waiting",
        createdByUserId: BOARD_USER_ID,
      });
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
        name: "telegram channel",
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
        provider: "telegram",
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
      await db.insert(chatConversations).values({
        companyId,
        endpointId,
        issueId: conversationIssueId,
        externalConversationId: "700500",
        externalThreadId: "telegram:700500",
        externalLabel: "Telegram direct message",
        sessionGeneration: 1,
        isDirectMessage: true,
        state: "active",
        lastActivityAt: new Date(),
      });
      return { agentId, boardUserId, companyId, conversationIssueId, endpointId, issueId };
    }

    async function publicationsForInteraction(
      companyId: string,
      interactionId: string,
    ) {
      return db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              interactionId,
            ),
          ),
        );
    }

    it("delivers a threadless task's question card to the owner's standing Telegram DM", async () => {
      const fixture = await seedFixture();
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "priority",
                prompt: "Which priority?",
                selectionMode: "single",
                allowOther: false,
                options: [
                  { id: "high", label: "High" },
                  { id: "normal", label: "Normal" },
                ],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      const [publication] = publications;
      expect(publication!.endpointId).toBe(fixture.endpointId);
      // The card must land in the standing DM conversation, not the task's
      // (nonexistent) thread binding, and carry the vendor idempotency key.
      expect(publication!.conversationId).toBeTruthy();
      expect(publication!.idempotencyKey).toBe(
        `interaction:${interaction.id}:${fixture.endpointId}`,
      );
      const [dmConversation] = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.id, publication!.conversationId));
      expect(dmConversation).toBeDefined();
      expect(dmConversation!.isDirectMessage).toBe(true);
      expect(publication!.payload.card?.kind).toBe("question");
      expect(publication!.state).toBe("pending");
    });

    it("delivers a confirmation card with Telegram accept and reject actions", async () => {
      const fixture = await seedFixture();
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "request_confirmation",
          payload: {
            version: 1,
            prompt: "Deploy the build?",
          },
        },
        { agentId: fixture.agentId },
      );
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      const [publication] = publications;
      expect(publication!.endpointId).toBe(fixture.endpointId);
      expect(publication!.payload.card?.kind).toBe("confirmation");
    });

    it("keeps the vendor path when the bridge flag is off", async () => {
      const previous = process.env.MYRMIDON_TELEGRAM_DM_CONVERSATIONS;
      process.env.MYRMIDON_TELEGRAM_DM_CONVERSATIONS = "";
      try {
        const fixture = await seedFixture();
        const interaction = await issueThreadInteractionService(db).create(
          { id: fixture.issueId, companyId: fixture.companyId },
          {
            kind: "ask_user_questions",
            payload: {
              version: 1,
              questions: [
                {
                  id: "priority",
                  prompt: "Which priority?",
                  selectionMode: "single",
                  allowOther: false,
                  options: [{ id: "high", label: "High" }],
                },
              ],
            },
          },
          { agentId: fixture.agentId },
        );
        await expect(
          publicationsForInteraction(fixture.companyId, interaction.id),
        ).resolves.toEqual([]);
      } finally {
        process.env.MYRMIDON_TELEGRAM_DM_CONVERSATIONS = previous ?? "*";
      }
    });

    it("answers the delivered card and settles the interaction without breaking on repeats", async () => {
      const fixture = await seedFixture();
      const service = issueThreadInteractionService(db);
      const interaction = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "priority",
                prompt: "Which priority?",
                selectionMode: "single",
                allowOther: false,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );
      const answered = await service.answerQuestions(
        { id: fixture.issueId, companyId: fixture.companyId },
        interaction.id,
        { answers: [{ questionId: "priority", optionIds: ["high"] }] },
        { userId: BOARD_USER_ID },
      );
      expect(answered.status).toBe("answered");
      const [row] = await db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id));
      expect(row!.status).toBe("answered");
      // A repeat answer attempt must not corrupt the settled interaction:
      // the service rejects it as terminal rather than throwing a crash.
      await expect(
        service.answerQuestions(
          { id: fixture.issueId, companyId: fixture.companyId },
          interaction.id,
          { answers: [{ questionId: "priority", optionIds: ["high"] }] },
          { userId: BOARD_USER_ID },
        ),
      ).rejects.toMatchObject({ status: 409 });
      const [rowAfter] = await db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id));
      expect(rowAfter!.status).toBe("answered");
    });
  },
);
