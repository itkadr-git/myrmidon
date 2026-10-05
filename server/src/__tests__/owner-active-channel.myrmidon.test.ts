// myrmidon(1.7-ACTIVE-CHANNEL): integration coverage of the acceptance
// criteria on the real delivery path.
//
//   1. The owner's inbound Telegram message marks the Telegram channel active
//      (markOwnerActivity, the same call the bridge intake makes) and a report
//      card still goes to Telegram.
//   2. The owner active in the portal keeps the card board-only — the delivery
//      gate reads the threshold live: PATCHing it through the service changes
//      the next delivery decision without a restart.
//
// Fixtures follow server/src/__tests__/owner-telegram-delivery.myrmidon.test.ts
// (U2, the standing Telegram DM conversation) plus the activity-store writes.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import { markOwnerActivity } from "../myrmidon/owner-active-channel/store.js";
import {
  invalidateOwnerActiveChannelSettingsCache,
} from "../myrmidon/owner-active-channel/settings.js";
import { ownerActiveChannelService } from "../myrmidon/owner-active-channel/service.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres(
  "owner active channel drives report delivery (1.7-ACTIVE-CHANNEL)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const secretsTmpDir = path.join(
      os.tmpdir(),
      `paperclip-myrmidon-active-channel-${randomUUID()}`,
    );

    beforeAll(async () => {
      mkdirSync(secretsTmpDir, { recursive: true });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
        secretsTmpDir,
        "master.key",
      );
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-active-channel-",
      );
      db = createDb(tempDb.connectionString);
    }, 30_000);

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

    async function seedFixture() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const boardUserId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `AC ${companyId.slice(0, 8)}`,
        issuePrefix: `AC${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
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
        membershipRole: "operator",
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

      const [workIssue] = await db
        .insert(issues)
        .values({
          companyId,
          title: "Owner report question",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: agentId,
          responsibleUserId: boardUserId,
          createdByUserId: boardUserId,
        })
        .returning();

      return { companyId, agentId, boardUserId, endpointId, dmIssue, workIssue };
    }

    async function createQuestionCard(fixture: Awaited<ReturnType<typeof seedFixture>>) {
      return issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            questions: [
              {
                id: "window",
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

    it("an owner Telegram message marks Telegram active and the card goes there", async () => {
      invalidateOwnerActiveChannelSettingsCache();
      const fixture = await seedFixture();
      // The inbound-message touch the bridge intake performs (chat-channels.ts).
      await markOwnerActivity(db, { userId: fixture.boardUserId, channel: "telegram" });

      const interaction = await createQuestionCard(fixture);
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      expect(publications[0]!.endpointId).toBe(fixture.endpointId);
      invalidateOwnerActiveChannelSettingsCache();
    });

    it("an owner active in the portal keeps the card board-only", async () => {
      invalidateOwnerActiveChannelSettingsCache();
      const fixture = await seedFixture();
      // Portal session touch, fresh; Telegram silent.
      await markOwnerActivity(db, { userId: fixture.boardUserId, channel: "web" });

      const interaction = await createQuestionCard(fixture);
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(0);
      invalidateOwnerActiveChannelSettingsCache();
    });

    it("changing the threshold live flips the next delivery decision", async () => {
      invalidateOwnerActiveChannelSettingsCache();
      const fixture = await seedFixture();
      // Portal activity 60 minutes ago: with the 120-minute default the owner
      // still counts as active on the board, so the card stays board-only.
      await markOwnerActivity(db, {
        userId: fixture.boardUserId,
        channel: "web",
        at: new Date(Date.now() - 60 * 60_000),
      });
      const service = ownerActiveChannelService(db);

      const first = await service.read(fixture.boardUserId);
      expect(first.channel).toBe("web");

      // The owner moves away from the keyboard; the operator lowers the
      // threshold through the API — no restart, the next read sees it.
      await service.update(
        { thresholdMin: 30 },
        { actorType: "user", actorId: fixture.boardUserId, agentId: null, runId: null, agentApiKeyId: null },
      );
      const second = await service.read(fixture.boardUserId);
      expect(second.thresholdMin).toBe(30);
      expect(second.thresholdSource).toBe("settings");
      expect(second.channel).toBeNull();

      // A Telegram message then makes Telegram the active channel end to end.
      await markOwnerActivity(db, { userId: fixture.boardUserId, channel: "telegram" });
      const third = await service.read(fixture.boardUserId);
      expect(third.channel).toBe("telegram");
      invalidateOwnerActiveChannelSettingsCache();
    });
  },
);
