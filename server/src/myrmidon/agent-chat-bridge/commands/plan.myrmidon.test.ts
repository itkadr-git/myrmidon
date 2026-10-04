// myrmidon(1.6-CTO-CHAT-B): the `/plan` DM command. Red on pre-feature main:
// `./plan.ts` does not exist there and `TELEGRAM_DM_COMMANDS` has no `plan`
// entry.
//
// Coverage pattern follows `commands.myrmodon.test.ts` (TG-MULTI-AGENT
// acceptance shape): a real embedded-postgres database and a fake planner
// gateway — no live network, no keys, no module mocks. The acceptance
// criteria of the ticket are the three scenarios below:
//   1. the owner's `/plan …` creates a pending `suggest_tasks` card on the
//      conversation task and answers with a link;
//   2. a non-owner gets a refusal and no card is created;
//   3. a planner failure answers with a readable line, no stack trace.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { telegramConversationUserId } from "../identity.js";
import {
  runBridgedDirectMessageCommand,
  TELEGRAM_DM_COMMANDS,
  type BridgedCommandInput,
} from "./index.js";
import { handlePlanCommand } from "./plan.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("myrmidon(1.6-CTO-CHAT-B) /plan DM command", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;
  let ownerId: string;
  let strangerId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("myrmidon-cto-chat-plan-dm-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    ownerId = randomUUID();
    strangerId = randomUUID();

    await db.insert(authUsers).values([
      { id: ownerId, name: "Owner", email: "owner@example.com", createdAt: new Date(), updatedAt: new Date() },
      { id: strangerId, name: "Stranger", email: "stranger@example.com", createdAt: new Date(), updatedAt: new Date() },
    ]);
    await db.insert(companies).values({
      id: companyId,
      name: "Plan DM Co",
      issuePrefix: "PDC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent A",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    await db.insert(companyMemberships).values([
      { companyId, principalId: ownerId, principalType: "user", status: "active", membershipRole: "owner" },
      { companyId, principalId: strangerId, principalType: "user", status: "active", membershipRole: "viewer" },
    ]);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  /** The owner's standing Telegram DM conversation (the X8b row shape). */
  async function createTelegramConversation(boardUserId: string) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Telegram chat",
        conversationAgentId: agentId,
        conversationUserId: telegramConversationUserId(boardUserId),
        assigneeAgentId: agentId,
        status: "in_review",
        conversationState: "waiting",
      })
      .returning();
    return issue!;
  }

  function baseInput(
    overrides: Partial<BridgedCommandInput> & Pick<BridgedCommandInput, "conversationIssueId" | "boardUserId" | "text">,
  ): BridgedCommandInput {
    return {
      db,
      companyId,
      agentId,
      endpointId: "endpoint-a",
      deliveryId: randomUUID(),
      publicBaseUrl: null,
      cancelRun: async () => ({}),
      ...overrides,
    };
  }

  async function interactionsFor(issueId: string) {
    return db
      .select()
      .from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId)));
  }

  /** The fake planner gateway: one good JSON answer, like the cto-chat tests. */
  function fakeGateway(content: string) {
    return (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      }) as unknown as Response) as unknown as typeof fetch;
  }

  const GOOD_ANSWER = JSON.stringify({
    epic: { title: "Add a weekly report page", acceptanceCriteria: ["Numbers match the ledger"] },
    tasks: [{ clientKey: "api", title: "Report API", acceptanceCriteria: ["Empty week returns zeros"] }],
  });

  /** Planner seams a test controls: fake gateway, deterministic plan id, stub key. */
  const plannerDeps = {
    fetch: fakeGateway(GOOD_ANSWER),
    mintPlanId: () => "plan-deterministic-1",
    readCompanyKey: async () => "test-key",
  };

  // The command reads the planner contour from the environment per call; the
  // enabled-with-a-key contour of every "card" scenario comes from here.
  beforeAll(() => {
    process.env.MYRMIDON_CTO_CHAT_BASE_URL = "https://gateway.example.com/v1";
    process.env.MYRMIDON_CTO_CHAT_KEY_SECRET = "cto-chat-key";
  });
  afterAll(() => {
    delete process.env.MYRMIDON_CTO_CHAT_BASE_URL;
    delete process.env.MYRMIDON_CTO_CHAT_KEY_SECRET;
  });

  it("1. /plan from the owner creates a pending suggest_tasks card on the conversation task and answers naming the proposal", async () => {
    const issue = await createTelegramConversation(ownerId);
    const result = await handlePlanCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId: ownerId, text: "/plan сделай отчёт" }),
      "сделай отчёт",
      plannerDeps,
    );

    expect(result).toMatchObject({ kind: "reply", command: "plan" });
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("Add a weekly report page");
    expect(text).toContain("1 task(s) proposed for your approval");

    // The SAME card the portal entry posts: pending suggest_tasks on the host task.
    const rows = await interactionsFor(issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("suggest_tasks");
    expect(rows[0]!.status).toBe("pending");
  });

  it("2. /plan from a non-owner is refused and no card is created", async () => {
    const issue = await createTelegramConversation(strangerId);
    // Even with a working planner behind it, the command must not reach it.
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId: strangerId, text: "/plan что угодно" }),
    );

    expect(result).toMatchObject({ kind: "reply", command: "plan" });
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toBe("Команда /plan доступна только владельцу компании.");
    expect(await interactionsFor(issue.id)).toHaveLength(0);
  });

  it("3. a planner failure answers with one readable line and no stack trace", async () => {
    const issue = await createTelegramConversation(ownerId);
    // A gateway that answers 500 makes the planner throw backend_failed,
    // which the entry module reports as a `rejected` outcome — the reply must
    // stay a single readable line, and the board must stay untouched.
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const result = await handlePlanCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId: ownerId, text: "/plan x" }),
      "x",
      { ...plannerDeps, fetch: failing },
    );

    expect(result).toMatchObject({ kind: "reply", command: "plan" });
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("could not turn that into a plan");
    expect(text.split("\n")).toHaveLength(1);
    expect(text).not.toMatch(/at\\s|Error:|stack/i);
    expect(await interactionsFor(issue.id)).toHaveLength(0);
  });

  it("4. /plan without text asks for the request instead of calling the planner", async () => {
    const issue = await createTelegramConversation(ownerId);
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId: ownerId, text: "/plan" }),
    );
    expect(result).toMatchObject({
      kind: "reply",
      command: "plan",
      text: "Напишите запрос после команды: /plan <что нужно спланировать>.",
    });
    expect(await interactionsFor(issue.id)).toHaveLength(0);
  });

  it("5. /plan is in the Telegram command menu the bridge publishes", () => {
    // TELEGRAM_DM_COMMANDS is the list X8e syncs into the Telegram bot menu.
    expect(TELEGRAM_DM_COMMANDS.map((spec) => spec.command)).toContain("plan");
  });
});
