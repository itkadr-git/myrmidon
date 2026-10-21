// myrmidon(U2): integration coverage for delivering an agent's question and
// confirmation cards to the owner's standing Telegram DM conversation (the X8b
// bridge) when the task the card belongs to has no chat-thread binding of its
// own. Fixtures follow server/src/__tests__/chat-interaction-publications.test.ts
// (vendor, not edited) plus the standing-conversation shape from
// server/src/myrmidon/agent-chat-bridge (X8a/X8b).
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "@chat-adapter/telegram";
import {
  agents,
  authUsers,
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  issues,
  instanceSettings,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  OWNER_DELIVERY_SETTINGS_KEY,
  type ChatProvider,
  type SafeChatPublicationPayload,
} from "@paperclipai/shared";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { readOwnerDeliveryMode } from "../myrmidon/owner-delivery/telegram-owner-bindings.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { enqueueIssueInteractionChatPublications } from "../services/chat-interaction-publications.js";
import { safeCardForPublication } from "../services/chat-channels.js";
import { logger } from "../middleware/logger.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/** Records what would reach the Telegram Bot API instead of calling it. */
class CapturingTelegramAdapter extends TelegramAdapter {
  readonly requests: Array<{
    method: string;
    payload?: Record<string, unknown> | FormData;
  }> = [];

  constructor() {
    super({
      botToken: "123:test-token",
      mode: "webhook",
      secretToken: "test-webhook-secret",
      userName: "paperclip_test_bot",
    });
  }

  protected override async telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData,
  ): Promise<TResult> {
    this.requests.push({ method, payload });
    return {
      message_id: 41,
      date: 1_700_000_000,
      chat: { id: 123, type: "private" },
      text: "sent",
    } as TResult;
  }

  sendMessageBody(): Record<string, unknown> {
    const send = this.requests.find(({ method }) => method === "sendMessage");
    return (send?.payload ?? {}) as Record<string, unknown>;
  }
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres(
  "owner Telegram delivery of question and confirmation cards (U2)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    const previousMyrmidonPublicUrl = process.env.MYRMIDON_PUBLIC_URL;
    const publicUrlEnvNames = [
      "AUTH_PUBLIC_BASE_URL",
      "MYRMIDON_AUTH_PUBLIC_BASE_URL",
      "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_BASE_URL",
      "MANAGED_RUNTIME_PUBLIC_URL",
      "MYRMIDON_MANAGED_RUNTIME_PUBLIC_URL",
      "PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL",
    ] as const;
    const previousPublicUrlPrecedence = Object.fromEntries(
      publicUrlEnvNames.map((name) => [name, process.env[name]]),
    );
    const secretsTmpDir = path.join(
      os.tmpdir(),
      `paperclip-myrmidon-u2-owner-delivery-${randomUUID()}`,
    );

    beforeAll(async () => {
      mkdirSync(secretsTmpDir, { recursive: true });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
        secretsTmpDir,
        "master.key",
      );
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-u2-owner-delivery-",
      );
      db = createDb(tempDb.connectionString);
    }, 30_000);

    beforeEach(async () => {
      for (const name of publicUrlEnvNames) delete process.env[name];
      process.env.PAPERCLIP_PUBLIC_URL = "https://board.example";
      // Each scenario opts into owner delivery explicitly; do not leak the
      // singleton setting from a preceding scenario.
      await instanceSettingsService(db).updateGeneral({
        [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "via_bot" },
      });
    });

    afterEach(async () => {
      await instanceSettingsService(db).updateGeneral({
        [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "via_bot" },
      });
      if (previousPublicUrl === undefined)
        delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
      if (previousMyrmidonPublicUrl === undefined)
        delete process.env.MYRMIDON_PUBLIC_URL;
      else process.env.MYRMIDON_PUBLIC_URL = previousMyrmidonPublicUrl;
      for (const name of publicUrlEnvNames) {
        const value = previousPublicUrlPrecedence[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    afterAll(async () => {
      await tempDb?.cleanup();
      if (previousKeyFile === undefined)
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      rmSync(secretsTmpDir, { recursive: true, force: true });
    });

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

    /**
     * Seeds: a company with an owner board user; a task-owned agent; a
     * standing Telegram DM conversation issue for (agent, owner) with a live
     * chat_conversations binding; and a plain work task (responsible user =
     * owner, no conversation identity, no chat binding).
     */
    async function seedFixture() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const boardUserId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `U2 delivery ${companyId.slice(0, 8)}`,
        issuePrefix: `U2${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
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
        membershipRole: "owner",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Bridget",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      // Telegram endpoint whose immutable assigned agent is the card author.
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
        publicationMode: "automatic",
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

      // Standing Telegram DM conversation issue (X8b shape) + binding.
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
      await db.insert(chatConversations).values({
        companyId,
        endpointId,
        resourceId: dmResourceId,
        issueId: dmIssue.id,
        externalConversationId: `telegram-dm-${companyId.slice(0, 8)}`,
        externalThreadId: `telegram-dm-${companyId.slice(0, 8)}:thread`,
        sessionGeneration: 1,
        externalLabel: "Telegram DM",
        isDirectMessage: true,
        state: "active",
        lastActivityAt: new Date(),
      });

      // The plain work task: responsible user = owner, no conversation
      // identity, no chat binding.
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

      return { companyId, agentId, boardUserId, endpointId, dmIssue, workIssue };
    }

    it("uses the canonical rebrand public URL when configured", async () => {
      const fixture = await seedFixture();
      process.env.MYRMIDON_PUBLIC_URL = "https://myrmidon.example";
      process.env.PAPERCLIP_PUBLIC_URL = "https://myrmidon.example";
      // Create while delivery is disabled; enable owner delivery before the
      // explicit enqueue so this test isolates URL projection from creation.
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          resolverPolicy: "human_only" as const,
          payload: {
            version: 1 as const,
            title: "Canonical URL question",
            questions: [{
              id: "canonical-url",
              prompt: "Which release?",
              selectionMode: "single" as const,
              allowOther: true,
              options: [{ id: "stable", label: "Stable" }],
            }],
          },
        },
        { agentId: fixture.agentId },
      );
      await instanceSettingsService(db).updateGeneral({
        [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" },
      });
      await enqueueIssueInteractionChatPublications(db, interaction);
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      const publication = publications[0];
      expect(publication).toBeDefined();
      expect((publication!.payload as { text?: string }).text).toContain(
        `https://myrmidon.example/issues/${fixture.workIssue.id}`,
      );
    });

    it("does not roll back an oversized interaction and tells the owner to answer on the board", async () => {
      const fixture = await seedFixture();
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          resolverPolicy: "human_only" as const,
          payload: {
            version: 1 as const,
            title: "A question with a large but valid prompt",
            questions: [{
              id: "large",
              prompt: "x".repeat(4_000),
              selectionMode: "single" as const,
              allowOther: true,
              options: [{ id: "option", label: "Option" }],
            }],
          },
        },
        { agentId: fixture.agentId },
      );

      await instanceSettingsService(db).updateGeneral({
        [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" },
      });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      try {
        const inserted = await enqueueIssueInteractionChatPublications(db, interaction);
        expect(inserted).toHaveLength(1);
        const payload = inserted[0]!.payload as SafeChatPublicationPayload;
        expect(payload.text).toContain("слишком длинный для Telegram");
        expect(payload.text).toContain("Ответить можно только на доске.");
        expect(payload.text).toContain(`https://board.example/issues/${fixture.workIssue.id}`);
        expect(payload.text).not.toContain("xxxxxxxx");
        expect(payload.interactionId).toBe(interaction.id);
        expect(payload).not.toHaveProperty("card");
        const logged = warn.mock.calls.find(
          ([fields]) =>
            (fields as { interactionId?: string } | undefined)?.interactionId ===
            interaction.id,
        );
        expect(logged).toBeDefined();
        // The log trace carries ids only, never the question text.
        expect(JSON.stringify(logged)).not.toContain("xxxxxxxx");
      } finally {
        warn.mockRestore();
      }
      const [stored] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, fixture.workIssue.id));
      expect(stored?.id).toBe(fixture.workIssue.id);
    });

    it("sends a board-only notice for confirmations that cannot be shown as text", async () => {
      const fixture = await seedFixture();
      const created = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "request_confirmation" as const,
          continuationPolicy: "wake_assignee" as const,
          resolverPolicy: "human_only" as const,
          payload: {
            version: 1 as const,
            prompt: "Approve the sensitive change?",
            detailsMarkdown: "SENSITIVE-DETAILS",
          },
        },
        { agentId: fixture.agentId },
      );
      // Only the sensitive-payload markers matter to the renderer; the
      // persisted proposal shape is validated at create time elsewhere.
      const interaction = {
        ...created,
        payload: { ...created.payload, secretProposal: {} },
      } as unknown as typeof created;
      await instanceSettingsService(db).updateGeneral({
        [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" },
      });
      const inserted = await enqueueIssueInteractionChatPublications(db, interaction);
      expect(inserted).toHaveLength(1);
      const payload = inserted[0]!.payload as SafeChatPublicationPayload;
      expect(payload.text).toContain("Ответить можно только на доске.");
      expect(payload.text).toContain(`https://board.example/issues/${fixture.workIssue.id}`);
      expect(payload.text).not.toContain("SENSITIVE-DETAILS");
      expect(payload.text).not.toContain("Approve the sensitive change?");
      expect(payload.interactionId).toBe(interaction.id);
      expect(payload).not.toHaveProperty("card");
    });

    it("hands Telegram a plain message with no reply_markup even when the endpoint allows actions", async () => {
      const fixture = await seedFixture();
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          resolverPolicy: "human_only" as const,
          payload: {
            version: 1 as const,
            title: "Pick a color",
            questions: [{
              id: "color",
              prompt: "Which color?",
              selectionMode: "single" as const,
              allowOther: false,
              options: [
                { id: "red", label: "Red" },
                { id: "blue", label: "Blue" },
              ],
            }],
          },
        },
        { agentId: fixture.agentId },
      );
      await instanceSettingsService(db).updateGeneral({
        [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" },
      });
      await enqueueIssueInteractionChatPublications(db, interaction);
      const [publication] = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      const payload = publication!.payload as SafeChatPublicationPayload;
      const [endpoint] = await db
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, fixture.endpointId));
      expect(endpoint!.capabilities.actions).toBe(true);

      // The sender builds the card from payload.card; none means a plain post.
      expect(safeCardForPublication(payload, "telegram")).toBeNull();
      const adapter = new CapturingTelegramAdapter();
      await adapter.postMessage("telegram:123", payload.text);
      const body = adapter.sendMessageBody();
      expect(body).toHaveProperty("text");
      expect(body).not.toHaveProperty("reply_markup");
      expect(JSON.stringify(body)).not.toContain("inline_keyboard");
      expect(JSON.stringify(body)).not.toContain("callback_data");
    });

    it("delivers owner questions as complete plain text without actions", async () => {
      const fixture = await seedFixture();
      const question = {
        kind: "ask_user_questions" as const,
        continuationPolicy: "wake_assignee" as const,
        resolverPolicy: "human_only" as const,
        payload: {
          version: 1 as const,
          title: "Choose a deploy window",
          questions: [
            {
              id: "deploy-window",
              header: "Choose a deploy window",
              prompt: "Which deploy window?",
              helpText: "Choose one and include any timing constraints.",
              selectionMode: "single" as const,
              allowOther: false,
              options: [
                { id: "morning", label: "Morning", description: "Before noon" },
                { id: "evening", label: "Evening", description: "After work" },
              ],
            },
          ],
        },
      };

      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        question,
        { agentId: fixture.agentId },
      );

      const beforeEnable = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(beforeEnable).toEqual([]);
      await instanceSettingsService(db).updateGeneral({ [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" } });
      const mode = await readOwnerDeliveryMode(db);
      expect(mode).toBe("owner_decisions_only");
      await enqueueIssueInteractionChatPublications(db, interaction);
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      expect(publications[0]!.conversationId).not.toBeNull();
      const payload = publications[0]!.payload as {
        text?: string;
        interactionId?: string;
        card?: unknown;
      };
      expect(payload.text).toContain("Choose a deploy window");
      expect(payload.text).toContain("Which deploy window?");
      expect(payload.text).toContain("Choose one and include any timing constraints.");
      expect(payload.text).toContain("1. Morning");
      expect(payload.text).toContain("   Before noon");
      expect(payload.text).toContain("2. Evening");
      expect(payload.text).toContain("   After work");
      expect(payload.text).toContain("Ответьте сообщением: номером варианта или своими словами.");
      expect(payload.text).toContain("https://board.example");
      expect(payload.interactionId).toBe(interaction.id);
      expect(payload).not.toHaveProperty("card");
      expect(payload.text).not.toContain("chat_action");
      const executableActions = await db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, fixture.companyId),
            eq(chatActions.conversationId, publications[0]!.conversationId),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              interaction.id,
            ),
          ),
        );
      expect(executableActions).toEqual([]);
      expect(payload.text!.length).toBeLessThanOrEqual(4_096);
      const [boundConversation] = await db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.companyId, fixture.companyId),
            inArray(
              chatConversations.id,
              publications.map((row) => row.conversationId),
            ),
          ),
        );
      expect(boundConversation?.issueId).toBe(fixture.dmIssue.id);
      expect(boundConversation?.isDirectMessage).toBe(true);
    });

    it("delivers confirmation details as plain text with no executable actions", async () => {
      const fixture = await seedFixture();
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "request_confirmation" as const,
          continuationPolicy: "wake_assignee" as const,
          resolverPolicy: "human_only" as const,
          payload: {
            version: 1 as const,
            prompt: "Proceed with the deploy?",
            detailsMarkdown: "Deploy build to production.",
            allowDeclineReason: true,
          },
        },
        { agentId: fixture.agentId },
      );

      const beforeEnable = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(beforeEnable).toEqual([]);
      await instanceSettingsService(db).updateGeneral({ [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" } });
      const mode = await readOwnerDeliveryMode(db);
      expect(mode).toBe("owner_decisions_only");
      await enqueueIssueInteractionChatPublications(db, interaction);
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      expect(publications[0]!.endpointId).toBe(fixture.endpointId);
      const payload = publications[0]!.payload as {
        text?: string;
        interactionId?: string;
        card?: unknown;
      };
      expect(payload.text).toContain("Proceed with the deploy?");
      expect(payload.text).toContain("Deploy build to production.");
      expect(payload.text).toContain("Ответьте сообщением: подтвердите или отклоните, либо своими словами.");
      expect(payload.interactionId).toBe(interaction.id);
      expect(payload).not.toHaveProperty("card");
    });

    it("keeps the card board-only when the owner has no standing Telegram conversation", async () => {
      const fixture = await seedFixture();
      // Retire the standing conversation: task stays owned but unbound.
      await db
        .update(chatConversations)
        .set({ state: "completed" })
        .where(
          and(
            eq(chatConversations.companyId, fixture.companyId),
            eq(chatConversations.endpointId, fixture.endpointId),
          ),
        );

      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            questions: [
              {
                id: "one",
                prompt: "Pick one",
                selectionMode: "single" as const,
                allowOther: false,
                options: [{ id: "a", label: "A" }],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );

      const publications = await enqueueIssueInteractionChatPublications(db, interaction);
      expect(publications).toEqual([]);
    });


    // myrmidon(1.6.5-OWNER-DM-FILTER): the owner-DM audience filter matrix.
    // The filter consumes the interaction's vendor-computed audience fields:
    // a card reaches the owner's DM only when it is addressed to a human
    // (effectiveResolverPolicy "human_only", or addresseeUserId = the task
    // owner). Agent-addressed and purely operational cards stay board-only.
    describe("owner-DM audience filter (1.6.5)", () => {
      beforeEach(async () => {
        await instanceSettingsService(db).updateGeneral({
          [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" },
        });
      });

      /** Read the stored card text of the single publication for an interaction. */
      async function publicationText(
        companyId: string,
        interactionId: string,
      ): Promise<string | null> {
        const rows = await publicationsForInteraction(companyId, interactionId);
        if (rows.length === 0) return null;
        const payload = rows[0]!.payload as { text?: string };
        return payload.text ?? null;
      }

      async function createCard(
        fixture: Awaited<ReturnType<typeof seedFixture>>,
        input: {
          resolverPolicy?: "anyone" | "not_creator" | "human_only";
          addresseeAgentId?: string;
          addresseeUserId?: string;
        } = {},
      ) {
        return issueThreadInteractionService(db).create(
          { id: fixture.workIssue.id, companyId: fixture.companyId },
          {
            kind: "request_confirmation" as const,
            continuationPolicy: "wake_assignee" as const,
            ...(input.resolverPolicy
              ? { resolverPolicy: input.resolverPolicy }
              : {}),
            ...(input.addresseeAgentId
              ? { addresseeAgentId: input.addresseeAgentId }
              : {}),
            ...(input.addresseeUserId
              ? { addresseeUserId: input.addresseeUserId }
              : {}),
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

      it("delivers a human_only card with no addressee to the owner's DM", async () => {
        const fixture = await seedFixture();
        const interaction = await createCard(fixture, {
          resolverPolicy: "human_only",
        });
        const publications = await publicationsForInteraction(
          fixture.companyId,
          interaction.id,
        );
        expect(publications).toHaveLength(1);
        expect(publications[0]!.endpointId).toBe(fixture.endpointId);
      });

      it("delivers a card addressed to the task owner to the owner's DM", async () => {
        const fixture = await seedFixture();
        const interaction = await createCard(fixture, {
          resolverPolicy: "not_creator",
          addresseeUserId: fixture.boardUserId,
        });
        const publications = await publicationsForInteraction(
          fixture.companyId,
          interaction.id,
        );
        expect(publications).toHaveLength(1);
        expect(publications[0]!.endpointId).toBe(fixture.endpointId);
      });

      it("keeps a card addressed to a different board user board-only", async () => {
        const fixture = await seedFixture();
        const otherUserId = randomUUID();
        await db
          .insert(authUsers)
          .values({
            id: otherUserId,
            name: "Other User",
            email: `other-${otherUserId.slice(0, 8)}@example.com`,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoNothing();
        await db.insert(companyMemberships).values({
          companyId: fixture.companyId,
          principalType: "user",
          principalId: otherUserId,
          role: "member",
          status: "active",
        });

        const interaction = await createCard(fixture, {
          resolverPolicy: "not_creator",
          addresseeUserId: otherUserId,
        });
        const publications = await publicationsForInteraction(
          fixture.companyId,
          interaction.id,
        );
        expect(publications).toEqual([]);
      });

      it("keeps an agent-addressed card board-only", async () => {
        const fixture = await seedFixture();
        const otherAgentId = randomUUID();
        await db.insert(agents).values({
          id: otherAgentId,
          companyId: fixture.companyId,
          name: "Agent B",
          role: "engineer",
          status: "idle",
          adapterType: "paperclip_runner",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        });

        const interaction = await createCard(fixture, {
          resolverPolicy: "not_creator",
          addresseeAgentId: otherAgentId,
        });
        const publications = await publicationsForInteraction(
          fixture.companyId,
          interaction.id,
        );
        expect(publications).toEqual([]);
      });

      it("keeps an operational card (no human addressee) board-only", async () => {
        const fixture = await seedFixture();
        for (const resolverPolicy of ["anyone", "not_creator"] as const) {
          const interaction = await createCard(fixture, { resolverPolicy });
          const publications = await publicationsForInteraction(
            fixture.companyId,
            interaction.id,
          );
          expect(publications).toEqual([]);
        }
      });

      it('mode "all" restores the pre-filter behaviour for operational cards', async () => {
        const fixture = await seedFixture();
        await instanceSettingsService(db).updateGeneral({
          [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "all" },
        });

        const interaction = await createCard(fixture, {
          resolverPolicy: "anyone",
        });
        const publications = await publicationsForInteraction(
          fixture.companyId,
          interaction.id,
        );
        expect(publications).toHaveLength(1);
        expect(publications[0]!.endpointId).toBe(fixture.endpointId);

        await instanceSettingsService(db).updateGeneral({
          [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" },
        });
      });

      // myrmidon(1.6.5-OWNER-VIA-BOT): under "via_bot" even a human_only card or
      // a card addressed straight to the owner is NOT published to the owner's DM.
      it('mode "via_bot" publishes no interactive card to the owner DM', async () => {
        const fixture = await seedFixture();
        await instanceSettingsService(db).updateGeneral({
          [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "via_bot" },
        });
        try {
          const humanOnly = await createCard(fixture, { resolverPolicy: "human_only" });
          const addressed = await createCard(fixture, {
            resolverPolicy: "not_creator",
            addresseeUserId: fixture.boardUserId,
          });
          expect(await publicationsForInteraction(fixture.companyId, humanOnly.id)).toEqual([]);
          expect(await publicationsForInteraction(fixture.companyId, addressed.id)).toEqual([]);
        } finally {
          await instanceSettingsService(db).updateGeneral({
            [OWNER_DELIVERY_SETTINGS_KEY]: { mode: "owner_decisions_only" },
          });
        }
      });

      it("keeps vendor bindings (chat-bound task) byte-for-byte on the vendor path", async () => {
        const fixture = await seedFixture();
        // Bind the work task to its own chat thread: the vendor binding path
        // wins and the owner-DM filter never runs.
        const resourceId = randomUUID();
        await db.insert(chatEndpointResources).values({
          id: resourceId,
          companyId: fixture.companyId,
          endpointId: fixture.endpointId,
          type: "group",
          providerResourceId: `telegram-group-${randomUUID()}`,
          label: "Team group",
          enabled: true,
          availability: "available",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await db.insert(chatConversations).values({
          companyId: fixture.companyId,
          endpointId: fixture.endpointId,
          resourceId,
          issueId: fixture.workIssue.id,
          externalConversationId: `telegram-group-${fixture.companyId.slice(0, 8)}`,
          externalThreadId: `telegram-group-${fixture.companyId.slice(0, 8)}:thread`,
          sessionGeneration: 1,
          externalLabel: "Team group",
          isDirectMessage: false,
          state: "active",
          lastActivityAt: new Date(),
        });

        const interaction = await createCard(fixture, {
          resolverPolicy: "anyone",
        });
        const publications = await publicationsForInteraction(
          fixture.companyId,
          interaction.id,
        );
        expect(publications).toHaveLength(1);
        expect(publications[0]!.endpointId).toBe(fixture.endpointId);
        const text = await publicationText(fixture.companyId, interaction.id);
        expect(text).not.toBeNull();
        // Vendor text is the generic vendor card body, not the owner text.
        expect(text).toContain("This task needs an authorized response");
        // The vendor binding keeps its card with executable actions.
        const payload = publications[0]!.payload as SafeChatPublicationPayload;
        expect(payload.card?.actions?.length ?? 0).toBeGreaterThan(0);
        const card = safeCardForPublication(payload, "telegram");
        expect(card).not.toBeNull();
        const adapter = new CapturingTelegramAdapter();
        await adapter.postMessage("telegram:123", {
          card: card!,
          fallbackText: payload.text,
        });
        expect(adapter.sendMessageBody()).toHaveProperty("reply_markup");
      });
    });

    it("does not deliver a card authored by another agent through this endpoint", async () => {
      const fixture = await seedFixture();
      const foreignAgentId = randomUUID();
      await db.insert(agents).values({
        id: foreignAgentId,
        companyId: fixture.companyId,
        name: "Outsider",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            questions: [
              {
                id: "one",
                prompt: "Pick one",
                selectionMode: "single" as const,
                allowOther: false,
                options: [{ id: "a", label: "A" }],
              },
            ],
          },
        },
        { agentId: foreignAgentId },
      );

      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toEqual([]);
    });
  },
);
