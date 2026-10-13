// myrmidon(X9c): /agents, /to and /who in a bridged Telegram direct message
// conversation — which agent of the company the chat addresses, and the
// protections around that choice. Red on pre-X9c main: the commands do not
// exist there (`./agents.js` is missing, `/to` falls to the unknown-command
// reply, TELEGRAM_DM_COMMANDS has no agents/to/who entries).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { telegramConversationUserId } from "../identity.js";
import { TELEGRAM_DM_COMMANDS, runBridgedDirectMessageCommand, type BridgedCommandInput } from "./index.js";
import {
  applyStickyAgentOverride,
  readStickyAgentId,
  readTelegramAliases,
  resolveCompanyAgentByAlias,
} from "./agents.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("bridged Telegram DM addressing commands (X9c)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let agentAId: string;
  let agentBId: string;
  let agentNoAliasId: string;
  let agentTerminatedId: string;
  let otherCompanyAgentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("myrmidon-x9c-agents-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentAId = randomUUID();
    agentBId = randomUUID();
    agentNoAliasId = randomUUID();
    agentTerminatedId = randomUUID();
    otherCompanyAgentId = randomUUID();

    await db
      .insert(authUsers)
      .values({
        id: "local-board",
        name: "Local Board",
        email: "local@example.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(companies).values([
      { id: companyId, name: "X9c Test Co", issuePrefix: "X9C", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "X9c Other Co", issuePrefix: "X9D", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "agent-a",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: { telegramAliases: ["alpha", "a-1"] },
      },
      {
        id: agentBId,
        companyId,
        name: "agent-b",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: { telegramAliases: ["bravo"] },
      },
      {
        id: agentNoAliasId,
        companyId,
        name: "agent-c",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      {
        id: agentTerminatedId,
        companyId,
        name: "agent-gone",
        role: "engineer",
        status: "terminated",
        adapterType: "hermes_local",
        adapterConfig: { telegramAliases: ["gone"] },
      },
      {
        id: otherCompanyAgentId,
        companyId: otherCompanyId,
        name: "agent-x",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        // Same alias as agentA: the other company's card must never be found.
        adapterConfig: { telegramAliases: ["alpha"] },
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function createTelegramConversation(
    options: {
      agentId?: string;
      boardUserId?: string;
      assigneeAdapterOverrides?: Record<string, unknown> | null;
    } = {},
  ) {
    const conversationAgentId = options.agentId ?? agentAId;
    const boardUserId = options.boardUserId ?? randomUUID();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Telegram chat",
        conversationAgentId,
        conversationUserId: telegramConversationUserId(boardUserId),
        assigneeAgentId: conversationAgentId,
        status: "in_review",
        conversationState: "waiting",
        assigneeAdapterOverrides: options.assigneeAdapterOverrides ?? null,
      })
      .returning();
    return { issue: issue!, boardUserId, agentId: conversationAgentId };
  }

  async function createWebConversation(boardUserId = randomUUID()) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Web chat",
        conversationAgentId: agentAId,
        conversationUserId: boardUserId,
        assigneeAgentId: agentAId,
        status: "in_review",
        conversationState: "waiting",
      })
      .returning();
    return { issue: issue!, boardUserId };
  }

  function noopCancelRun(): BridgedCommandInput["cancelRun"] {
    return async () => ({});
  }

  function baseInput(
    overrides: Partial<BridgedCommandInput> & Pick<BridgedCommandInput, "conversationIssueId" | "boardUserId" | "text">,
  ): BridgedCommandInput {
    return {
      db,
      companyId,
      agentId: agentAId,
      endpointId: "endpoint-a",
      deliveryId: randomUUID(),
      publicBaseUrl: null,
      cancelRun: noopCancelRun(),
      ...overrides,
    };
  }

  async function replyOf(input: BridgedCommandInput): Promise<string> {
    const result = await runBridgedDirectMessageCommand(input);
    expect(result?.kind).toBe("reply");
    return (result as { kind: "reply"; text: string }).text;
  }

  async function readOverrides(issueId: string) {
    const [row] = await db
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, issueId));
    return (row?.assigneeAdapterOverrides as Record<string, unknown> | null) ?? null;
  }

  it("1. /agents lists the company's addressable agents with their aliases and marks the current addressee", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const text = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/agents" }));
    expect(text).toContain("agent-a (alpha, a-1) — current addressee");
    expect(text).toContain("agent-b (bravo)");
    expect(text).toContain("agent-c (—)");
    // The terminated agent is not addressable and is never listed.
    expect(text).not.toContain("agent-gone");
    // Never an internal id.
    expect(text).not.toContain(agentAId);
    expect(text).not.toContain(agentBId);
  });

  it("2. /to <alias> sets the sticky target, and it survives into the next message's /who", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const setText = await replyOf(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to bravo" }),
    );
    expect(setText).toContain("agent-b");
    expect(setText).toContain("bravo");
    expect(readStickyAgentId(await readOverrides(issue.id))).toBe(agentBId);

    // A separate command run — the state must be read back from the DB, not
    // from any in-memory handle: the sticky choice survives messages.
    const whoText = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/who" }));
    expect(whoText).toContain("agent-b (bravo) replies now — chosen with /to");
    expect(whoText).not.toContain("agent-a");
  });

  it("3. /who without a sticky target reports the chat's default agent", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const text = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/who" }));
    expect(text).toContain("agent-a (alpha, a-1) replies now — the chat's default agent");
    expect(text).not.toContain(agentAId);
  });

  it("4. /to with an unknown alias politely lists the valid aliases and writes nothing", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const text = await replyOf(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to nope" }),
    );
    expect(text).toContain("“nope”");
    expect(text).toContain("alpha, a-1, bravo");
    expect(readStickyAgentId(await readOverrides(issue.id))).toBeNull();
  });

  it("5. /to <alias> from another company is refused: the alias resolves only within the same company", async () => {
    // agent-x in the other company carries the alias "alpha" too; /to alpha
    // in this company's chat must resolve to agent-a, never to agent-x.
    const card = await resolveCompanyAgentByAlias(db, companyId, "alpha");
    expect(card?.id).toBe(agentAId);
    expect(card?.id).not.toBe(otherCompanyAgentId);

    const { issue, boardUserId } = await createTelegramConversation();
    await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to alpha" }));
    const overrides = await readOverrides(issue.id);
    expect(readStickyAgentId(overrides)).toBe(agentAId);
  });

  it("6. /to without an argument clears the sticky target", async () => {
    const { issue, boardUserId } = await createTelegramConversation({
      assigneeAdapterOverrides: { telegramStickyAgentId: agentBId },
    });
    const text = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to" }));
    expect(text).toContain("Addressee choice reset");
    const overrides = await readOverrides(issue.id);
    expect(overrides).toBeNull();
  });

  it("6b. /to with no sticky target set answers that the chat's default agent replies", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const text = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to" }));
    expect(text).toContain("agent-a");
    expect(text).toContain("No default addressee set");
  });

  it("7. /to is case-insensitive and accepts the @-prefixed form; a terminated agent is not addressable", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to @BRAVO" }));
    expect(readStickyAgentId(await readOverrides(issue.id))).toBe(agentBId);

    const refused = await replyOf(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to gone" }),
    );
    expect(refused).toContain("“gone”");
    expect(readStickyAgentId(await readOverrides(issue.id))).toBe(agentBId);
  });

  it("8. the sticky write keeps other override keys and never touches the model override", async () => {
    const { issue, boardUserId } = await createTelegramConversation({
      assigneeAdapterOverrides: { adapterConfig: { model: "model-a" } },
    });
    await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to bravo" }));
    const overrides = await readOverrides(issue.id);
    expect(overrides).toEqual({
      adapterConfig: { model: "model-a" },
      telegramStickyAgentId: agentBId,
    });

    // Clearing the sticky key leaves the model override intact.
    await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/to" }));
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "model-a" } });
  });

  it("9. the sticky change is activity-logged like the model override is", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    await applyStickyAgentOverride({
      db,
      companyId,
      issueId: issue.id,
      boardUserId,
      agentId: agentBId,
    });
    const rows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issue.id));
    const stickyEntries = rows
      .map((row) => row.details as Record<string, unknown> | null)
      .filter((details) => details?.conversationStickyAgent !== undefined);
    expect(stickyEntries.length).toBeGreaterThan(0);
    const entry = stickyEntries[0]!.conversationStickyAgent as Record<string, unknown>;
    expect(entry.key).toBe("telegramStickyAgentId");
    expect(entry.value).toBe(agentBId);
  });

  it("10. /agents and /to refuse a web conversation and another person's Telegram conversation, writing nothing", async () => {
    const web = await createWebConversation();
    const webResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: web.issue.id, boardUserId: web.boardUserId, text: "/to bravo" }),
    );
    expect(webResult).toEqual({ kind: "reply", command: "not-available", text: "This chat is not available." });

    const other = await createTelegramConversation({ boardUserId: randomUUID() });
    const otherResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: other.issue.id, boardUserId: randomUUID(), text: "/to bravo" }),
    );
    expect(otherResult).toEqual({ kind: "reply", command: "not-available", text: "This chat is not available." });

    expect(readStickyAgentId(await readOverrides(web.issue.id))).toBeNull();
    expect(readStickyAgentId(await readOverrides(other.issue.id))).toBeNull();
  });

  it("11. /agents marks the sticky target, not the conversation agent, as the current addressee", async () => {
    const { issue, boardUserId } = await createTelegramConversation({
      assigneeAdapterOverrides: { telegramStickyAgentId: agentBId },
    });
    const text = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/agents" }));
    expect(text).toContain("agent-b (bravo) — current addressee");
    expect(text).not.toContain("agent-a (alpha, a-1) — current addressee");
  });

  it("12. TELEGRAM_DM_COMMANDS carries /agents, /to and /who with menu descriptions", () => {
    const names = TELEGRAM_DM_COMMANDS.map((spec) => spec.command);
    expect(names).toContain("agents");
    expect(names).toContain("to");
    expect(names).toContain("who");
    for (const name of ["agents", "to", "who"]) {
      const spec = TELEGRAM_DM_COMMANDS.find((entry) => entry.command === name)!;
      expect(spec.description.length).toBeGreaterThan(0);
      // Bot API: 1-32 chars, [a-z0-9_]; description 3-256 chars.
      expect(spec.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(spec.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("13. /agents appears in /help, and /who and /to echo fixed command fields", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const help = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/help" }),
    );
    expect(help?.kind).toBe("reply");
    const helpText = (help as { kind: "reply"; text: string }).text;
    expect(helpText).toContain("/agents");
    expect(helpText).toContain("/to");
    expect(helpText).toContain("/who");

    for (const [text, command] of [
      ["/agents", "agents"],
      ["/to bravo", "to"],
      ["/who", "who"],
    ] as const) {
      const result = await runBridgedDirectMessageCommand(
        baseInput({ conversationIssueId: issue.id, boardUserId, text }),
      );
      expect(result).toMatchObject({ kind: "reply", command });
    }
  });

  it("14. readTelegramAliases tolerates malformed card data", () => {
    expect(readTelegramAliases({})).toEqual([]);
    expect(readTelegramAliases({ telegramAliases: "alpha" })).toEqual([]);
    expect(readTelegramAliases({ telegramAliases: [] })).toEqual([]);
    expect(readTelegramAliases({ telegramAliases: [null, 42, "", "  "] })).toEqual([]);
    expect(
      readTelegramAliases({ telegramAliases: ["Alpha", " ALPHA ", "bravo", 7] }),
    ).toEqual(["alpha", "bravo"]);
  });
});
