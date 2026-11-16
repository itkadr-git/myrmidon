// myrmidon(1.6.9 OWNER-ALERTS-DESIGNATED-BOT): the owner's system signals go through the chat of the DESIGNATED
// agent only. Every bot of the company shares one company, so "any active direct telegram chat" delivered a disk
// alert from the shop bot (16.11). Against an embedded Postgres: the right chat, no random chat, no chat -> null.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  chatConversations,
  chatEndpoints,
  companies,
  createDb,
  issues,
  toolApplications,
  toolConnections,
} from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { findActiveOwnerDeliveryConversation } from "./update-notify.js";
import { dbTelegramNotifyStore } from "../telegram-notify/settings-store.js";
import { emptyTelegramNotifyDocument } from "@myrmidon/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("owner delivery conversation is the designated agent's", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyCount = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-owner-delivery-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "owner-delivery", issuePrefix: `OD${String.fromCharCode(65 + companyCount++)}` });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: `bot-${id.slice(0, 4)}`, adapterType: "paperclip_runner", status: "active" });
    return id;
  }

  async function seedDm(companyId: string, agentId: string, lastActivityAt: Date) {
    const endpointId = randomUUID();
    const connectionId = randomUUID();
    const applicationId = randomUUID();
    const issueId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "dm", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(toolApplications).values({
      id: applicationId, companyId, applicationKey: `chat:telegram:${endpointId}`, name: `Telegram ${endpointId}`, type: "chat", status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, uid: endpointId, name: `Telegram ${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "telegram", publicId: randomUUID(), assignedAgentId: agentId, status: "active",
    });
    await db.insert(chatConversations).values({
      id: conversationId, companyId, endpointId, issueId, externalConversationId: `dm-${conversationId}`, externalLabel: "dm",
      isDirectMessage: true, state: "active", lastActivityAt,
    });
    return { endpointId, conversationId, issueId };
  }

  async function designate(companyId: string, agentId: string | null) {
    await dbTelegramNotifyStore(db).mutate(companyId, (current) => {
      const next = structuredClone(current ?? emptyTelegramNotifyDocument());
      next.settings.owner.agentId = agentId;
      return { next, result: null };
    });
  }

  it("two bots with active direct chats, the second designated: the second one's chat is chosen", async () => {
    const companyId = await seedCompany();
    const shopBot = await seedAgent(companyId);
    const boardBot = await seedAgent(companyId);
    // The shop bot is the NEWER chat: a "latest of any" rule would pick it.
    await seedDm(companyId, shopBot, new Date("2026-11-16T05:00:00Z"));
    const board = await seedDm(companyId, boardBot, new Date("2026-11-16T01:00:00Z"));
    await designate(companyId, boardBot);
    expect(await findActiveOwnerDeliveryConversation(db, companyId)).toEqual(board);
  });

  it("no designated agent: null, never a random chat", async () => {
    const companyId = await seedCompany();
    await seedDm(companyId, await seedAgent(companyId), new Date("2026-11-16T05:00:00Z"));
    await seedDm(companyId, await seedAgent(companyId), new Date("2026-11-16T06:00:00Z"));
    expect(await findActiveOwnerDeliveryConversation(db, companyId)).toBeNull();
  });

  it("designated agent without a conversation: null (the caller falls back to updates.chatId)", async () => {
    const companyId = await seedCompany();
    await seedDm(companyId, await seedAgent(companyId), new Date("2026-11-16T05:00:00Z"));
    const silent = await seedAgent(companyId);
    await designate(companyId, silent);
    expect(await findActiveOwnerDeliveryConversation(db, companyId)).toBeNull();
  });

  it("several chats of the designated agent: the latest activity wins", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedDm(companyId, agentId, new Date("2026-11-15T01:00:00Z"));
    const newest = await seedDm(companyId, agentId, new Date("2026-11-16T01:00:00Z"));
    await seedDm(companyId, agentId, new Date("2026-11-14T01:00:00Z"));
    await designate(companyId, agentId);
    expect(await findActiveOwnerDeliveryConversation(db, companyId)).toEqual(newest);
  });
});
