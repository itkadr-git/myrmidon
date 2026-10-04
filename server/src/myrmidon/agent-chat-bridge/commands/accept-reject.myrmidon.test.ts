/**
 * Guard for myrmidon(1.6.3-CTO-CHAT-B): the Telegram DM commands `/accept`
 * and `/reject` on the plan card. Acceptance criteria:
 *
 *  - `/accept` creates the epic and the tasks, the reply carries the link;
 *  - `/reject` closes the card without creating any task;
 *  - a repeated `/accept` creates no duplicates;
 *  - a user who does not own the conversation cannot accept.
 *
 * Runs against a real database (embedded postgres, as the vendor does — no
 * live network, no keys, no real Telegram API). The command itself runs
 * through `runBridgedDirectMessageCommand`, the same entry the Telegram
 * bridge uses, with a plain fake `cancelRun` — the "fake Telegram API" is
 * the delivery context passed to the command runner.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { ctoChatPlanSchema, type CtoChatPlan } from "@paperclipai/shared";
import { createCtoChatPlanApproval } from "../../cto-chat/plan-approval.js";
import { telegramConversationUserId } from "../identity.js";
import { runBridgedDirectMessageCommand, type BridgedCommandInput } from "./index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PUBLIC_BASE_URL = "https://board.example.com";

function plan(overrides: Partial<CtoChatPlan> = {}): CtoChatPlan {
  return ctoChatPlanSchema.parse({
    planId: `plan-${randomUUID()}`,
    epicClientKey: "epic",
    epic: { title: "Ship the weekly report", acceptanceCriteria: ["Numbers match the ledger"] },
    tasks: [
      { clientKey: "api", title: "Report API", acceptanceCriteria: ["Empty week returns zeros"] },
      { clientKey: "page", title: "Report page" },
    ],
    ...overrides,
  });
}

describeEmbeddedPostgres("myrmidon(1.6.3-CTO-CHAT-B) /accept and /reject in the Telegram DM", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-cto-accept-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Seeds a company, a chat agent, a standing Telegram conversation issue
   * owned by boardUserId, and a pending plan card on it. */
  async function seedWithCard() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const boardUserId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Example Co", issuePrefix: "EX" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      adapterType: "hermes_local",
      status: "active",
    });
    const [conversation] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Telegram chat",
        // The Telegram conversation key: "telegram:" + board user id — the
        // prefix is what marks this conversation as the Telegram one (X8a).
        conversationAgentId: agentId,
        conversationUserId: telegramConversationUserId(boardUserId),
        assigneeAgentId: agentId,
        status: "in_review",
        conversationState: "waiting",
      })
      .returning();

    const card = await createCtoChatPlanApproval(
      { plan: plan(), hostIssueId: conversation!.id, companyId, createdByAgentId: agentId },
      { db },
    );
    return { companyId, agentId, boardUserId, conversation, cardId: card.interactionId };
  }

  function commandInput(args: {
    companyId: string;
    agentId: string;
    boardUserId: string;
    conversationIssueId: string;
    text: string;
  }): BridgedCommandInput {
    return {
      db: db as unknown as BridgedCommandInput["db"],
      companyId: args.companyId,
      agentId: args.agentId,
      endpointId: "endpoint-1",
      deliveryId: `delivery-${randomUUID()}`,
      boardUserId: args.boardUserId,
      conversationIssueId: args.conversationIssueId,
      text: args.text,
      publicBaseUrl: PUBLIC_BASE_URL,
      cancelRun: async () => {},
    };
  }

  async function issueCount(companyId: string) {
    const rows = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId));
    return rows.length;
  }

  async function cardRow(companyId: string, interactionId: string) {
    const [row] = await db
      .select()
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.id, interactionId),
        ),
      );
    return row ?? null;
  }

  it("/accept creates the epic and the tasks and the reply carries the link", async () => {
    const { companyId, agentId, boardUserId, conversation, cardId } = await seedWithCard();
    const before = await issueCount(companyId);

    const result = await runBridgedDirectMessageCommand(
      commandInput({
        companyId,
        agentId,
        boardUserId,
        conversationIssueId: conversation!.id,
        text: `/accept ${cardId}`,
      }),
    );

    expect(result?.kind).toBe("reply");
    const reply = result as { kind: "reply"; command: string; text: string };
    expect(reply.command).toBe("accept");
    // 1 conversation + 1 epic + 2 tasks.
    expect(await issueCount(companyId)).toBe(before + 3);
    // The reply carries the epic link (the first created issue is the epic).
    const created = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, "Ship the weekly report")));
    expect(created).toHaveLength(1);
    expect(reply.text).toContain(`${PUBLIC_BASE_URL}/issues/${created[0]!.id}`);
    expect(reply.text).toContain("3");
    // The card closed.
    expect((await cardRow(companyId, cardId))?.status).toBe("accepted");
  });

  it("/reject closes the card without creating any task", async () => {
    const { companyId, agentId, boardUserId, conversation, cardId } = await seedWithCard();
    const before = await issueCount(companyId);

    const result = await runBridgedDirectMessageCommand(
      commandInput({
        companyId,
        agentId,
        boardUserId,
        conversationIssueId: conversation!.id,
        text: `/reject ${cardId}`,
      }),
    );

    expect(result).toEqual({
      kind: "reply",
      command: "reject",
      text: "❌ План отклонён. Задачи не созданы.",
    });
    expect(await issueCount(companyId)).toBe(before);
    expect((await cardRow(companyId, cardId))?.status).toBe("rejected");
    const row = await cardRow(companyId, cardId);
    expect((row!.result as { rejectionReason?: string }).rejectionReason).toBe(
      "rejected_by_owner_via_telegram",
    );
  });

  it("a repeated /accept creates no duplicates", async () => {
    const { companyId, agentId, boardUserId, conversation, cardId } = await seedWithCard();
    const before = await issueCount(companyId);

    const first = await runBridgedDirectMessageCommand(
      commandInput({
        companyId,
        agentId,
        boardUserId,
        conversationIssueId: conversation!.id,
        text: `/accept ${cardId}`,
      }),
    );
    expect(first?.kind).toBe("reply");
    const afterFirst = await issueCount(companyId);
    expect(afterFirst).toBe(before + 3);

    const second = await runBridgedDirectMessageCommand(
      commandInput({
        companyId,
        agentId,
        boardUserId,
        conversationIssueId: conversation!.id,
        text: `/accept ${cardId}`,
      }),
    );
    expect((second as { text: string }).text).toContain("уже обработана");
    expect(await issueCount(companyId)).toBe(afterFirst);
  });

  it("a user who does not own the conversation cannot accept", async () => {
    const { companyId, agentId, boardUserId, conversation, cardId } = await seedWithCard();
    const strangerId = randomUUID();

    const result = await runBridgedDirectMessageCommand(
      commandInput({
        companyId,
        agentId,
        boardUserId: strangerId,
        conversationIssueId: conversation!.id,
        text: `/accept ${cardId}`,
      }),
    );

    expect(result).toEqual({
      kind: "reply",
      command: "not-available",
      text: "Этот чат недоступен.",
    });
    expect((await cardRow(companyId, cardId))?.status).toBe("pending");
  });

  it("an unknown card id is reported, not thrown into the chat", async () => {
    const { companyId, agentId, boardUserId, conversation } = await seedWithCard();
    const result = await runBridgedDirectMessageCommand(
      commandInput({
        companyId,
        agentId,
        boardUserId,
        conversationIssueId: conversation!.id,
        text: `/accept ${randomUUID()}`,
      }),
    );
    expect(result?.kind).toBe("reply");
    expect((result as { text: string }).text).toContain("Не удалось принять карточку");
  });

  it("/accept without an argument asks for the card id", async () => {
    const { companyId, agentId, boardUserId, conversation } = await seedWithCard();
    const result = await runBridgedDirectMessageCommand(
      commandInput({
        companyId,
        agentId,
        boardUserId,
        conversationIssueId: conversation!.id,
        text: "/accept",
      }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "accept",
      text: "Укажите ID карточки: /accept <id> — ID карточки с планом из ответа бота.",
    });
  });
});
