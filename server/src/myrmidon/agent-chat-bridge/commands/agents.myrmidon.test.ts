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
import {
  addDefaultAliases,
  defaultAliasFromName,
  resolveBridgeAddressee,
} from "../addressing.js";
import { t } from "../locales/index.js";
import { TELEGRAM_DM_COMMANDS, runBridgedDirectMessageCommand, type BridgedCommandInput } from "./index.js";
import {
  applyStickyAgentOverride,
  buildAgentsReplyText,
  listCompanyAddressableAgents,
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

  // myrmidon(1.6.5 OPE-6318 part A): a second company whose fleet exercises
  // the grouped list — directions, a custom group, a computed-alias collision,
  // a paused card, an archived copy and a plugin-owned service card.
  let groupedCompanyId: string;
  let groupedInfraId: string;
  let groupedWorkId: string;
  let groupedBbqHostId: string;
  let groupedBbqPausedId: string;
  let groupedRetiredId: string;
  let groupedServiceId: string;
  let groupedDispatchId: string;
  let groupedQaId: string;
  let groupedLifeId: string;
  let groupedGoneId: string;

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

    // The grouped fleet lives in its own company, so the X9c fixtures above
    // keep the flat list's expectations intact.
    groupedCompanyId = randomUUID();
    groupedInfraId = randomUUID();
    groupedWorkId = randomUUID();
    groupedBbqHostId = randomUUID();
    groupedBbqPausedId = randomUUID();
    groupedRetiredId = randomUUID();
    groupedServiceId = randomUUID();
    groupedDispatchId = randomUUID();
    groupedQaId = randomUUID();
    groupedLifeId = randomUUID();
    groupedGoneId = randomUUID();

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
      { id: groupedCompanyId, name: "X9c Grouped Co", issuePrefix: "X9E", requireBoardApprovalForNewAgents: false },
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
    // myrmidon(1.6.5 OPE-6318 part A): the fleet that exercises the grouped
    // /agents — two directions by name prefix, one group named on the card,
    // two cards wanting the same short alias, and every kind of card that must
    // stay out of the list.
    await db.insert(agents).values([
      {
        id: groupedInfraId,
        companyId: groupedCompanyId,
        name: "adm-dev-eng-2",
        role: "engineer",
        title: "Engineer on duty",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      {
        id: groupedWorkId,
        companyId: groupedCompanyId,
        name: "work-runner-2",
        role: "worker",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      {
        id: groupedBbqHostId,
        companyId: groupedCompanyId,
        name: "bbq-host",
        role: "host",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      {
        id: groupedBbqPausedId,
        companyId: groupedCompanyId,
        name: "bbq-editor",
        role: "editor",
        title: "Editor",
        status: "paused",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      {
        id: groupedRetiredId,
        companyId: groupedCompanyId,
        name: "legacy-bot-retired",
        role: "legacy",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      {
        id: groupedServiceId,
        companyId: groupedCompanyId,
        name: "Wiki Maintainer",
        role: "service",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        // A plugin-owned card: the fleet's service agents carry this shape.
        metadata: {
          pluginManagedAgent: { plugin: "wiki" },
          paperclipManagedResource: { kind: "agent" },
        },
      },
      {
        id: groupedDispatchId,
        companyId: groupedCompanyId,
        name: "dispatch",
        role: "dispatcher",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        metadata: { telegramGroup: "Dispatch Squad" },
      },
      {
        id: groupedQaId,
        companyId: groupedCompanyId,
        name: "qa17",
        role: "qa",
        status: "running",
        adapterType: "hermes_local",
        adapterConfig: {},
        metadata: { telegramGroup: "Dispatch Squad" },
      },
      {
        id: groupedLifeId,
        companyId: groupedCompanyId,
        name: "life",
        role: "life",
        status: "running",
        adapterType: "hermes_local",
        adapterConfig: {},
        metadata: { telegramAliases: ["life-bot"] },
      },
      {
        id: groupedGoneId,
        companyId: groupedCompanyId,
        name: "work-gone",
        role: "worker",
        status: "terminated",
        adapterType: "hermes_local",
        adapterConfig: {},
        metadata: { telegramGroup: "Dispatch Squad" },
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
      companyId?: string;
      boardUserId?: string;
      assigneeAdapterOverrides?: Record<string, unknown> | null;
    } = {},
  ) {
    const conversationAgentId = options.agentId ?? agentAId;
    const conversationCompanyId = options.companyId ?? companyId;
    const boardUserId = options.boardUserId ?? randomUUID();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: conversationCompanyId,
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
    const text = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/agents text" }));
    // Name, live status and aliases per line; no card carries a group name, so
    // they all fall into the prefix fallback's last bucket.
    expect(text).toContain(t("en", "agents.groupHeader", { group: t("en", "agents.group.other") }));
    expect(text).toContain(
      `${t("en", "agents.lineNoRole", {
        name: "agent-a",
        status: t("en", "agents.status.idle"),
        aliases: "alpha, a-1",
      })} — ${t("en", "agents.currentSuffix")}`,
    );
    expect(text).toContain(
      t("en", "agents.lineNoRole", { name: "agent-b", status: t("en", "agents.status.idle"), aliases: "bravo" }),
    );
    // A card without telegramAliases still shows the alias computed from its name.
    expect(text).toContain(
      t("en", "agents.lineNoRole", { name: "agent-c", status: t("en", "agents.status.idle"), aliases: "c" }),
    );
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
    expect(text).toContain("alpha, a-1, bravo, c");
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
    const text = await replyOf(baseInput({ conversationIssueId: issue.id, boardUserId, text: "/agents text" }));
    expect(text).toContain(
      `${t("en", "agents.lineNoRole", {
        name: "agent-b",
        status: t("en", "agents.status.idle"),
        aliases: "bravo",
      })} — ${t("en", "agents.currentSuffix")}`,
    );
    expect(text).not.toContain(
      `${t("en", "agents.lineNoRole", {
        name: "agent-a",
        status: t("en", "agents.status.idle"),
        aliases: "alpha, a-1",
      })} — ${t("en", "agents.currentSuffix")}`,
    );
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

  it("15. /agents groups the live cards by direction, naming each agent's role, status and alias", async () => {
    const { issue, boardUserId } = await createTelegramConversation({
      companyId: groupedCompanyId,
      agentId: groupedInfraId,
    });
    const text = await replyOf(
      baseInput({
        companyId: groupedCompanyId,
        agentId: groupedInfraId,
        conversationIssueId: issue.id,
        boardUserId,
        text: "/agents text",
      }),
    );

    // A group per direction: the titles come from the catalogs, one group is
    // named on the card itself.
    for (const key of ["agents.group.infra", "agents.group.work", "agents.group.other"] as const) {
      expect(text).toContain(t("en", "agents.groupHeader", { group: t("en", key) }));
    }
    expect(text).toContain(t("en", "agents.groupHeader", { group: "Dispatch Squad" }));
    // The paused member stays out of the list, but its group says how many wait.
    expect(text).toContain(
      t("en", "agents.groupHeaderPaused", { group: t("en", "agents.group.bbq"), count: 1 }),
    );

    // One line per live card: name, role (one line), live status, aliases.
    expect(text).toContain(
      `${t("en", "agents.line", {
        name: "adm-dev-eng-2",
        role: "Engineer on duty",
        status: t("en", "agents.status.idle"),
        aliases: "2",
      })} — ${t("en", "agents.currentSuffix")}`,
    );
    for (const [name, statusKey, aliases] of [
      ["work-runner-2", "agents.status.idle", "2-2"],
      ["bbq-host", "agents.status.idle", "host"],
      ["dispatch", "agents.status.idle", "dispatch"],
      ["qa17", "agents.status.running", "qa17"],
      ["life", "agents.status.running", "life-bot"],
    ] as const) {
      expect(text).toContain(
        t("en", "agents.lineNoRole", { name, status: t("en", statusKey), aliases }),
      );
    }

    // Written-off, archived and plugin-owned service cards are not listed at all.
    for (const hidden of ["bbq-editor", "legacy-bot-retired", "Wiki Maintainer", "work-gone"]) {
      expect(text).not.toContain(hidden);
    }
    // Never an internal id.
    for (const id of [groupedInfraId, groupedWorkId, groupedBbqHostId, groupedServiceId]) {
      expect(text).not.toContain(id);
    }
  });

  it("16. a card without telegramAliases answers to the alias computed from its name, collisions get -2", async () => {
    // Read-time computation: /to, /agents and @mentions all see the same alias.
    expect((await resolveCompanyAgentByAlias(db, groupedCompanyId, "2"))?.id).toBe(groupedInfraId);
    expect((await resolveCompanyAgentByAlias(db, groupedCompanyId, "2-2"))?.id).toBe(groupedWorkId);
    expect((await resolveCompanyAgentByAlias(db, groupedCompanyId, "host"))?.id).toBe(groupedBbqHostId);
    // The card's own telegramAliases still wins, and its name stays mentionable.
    expect((await resolveCompanyAgentByAlias(db, groupedCompanyId, "life-bot"))?.id).toBe(groupedLifeId);
    const lifeMention = await resolveBridgeAddressee(db, {
      companyId: groupedCompanyId,
      text: "@life ping",
      endpointAgentId: groupedInfraId,
    });
    expect(lifeMention?.agentId).toBe(groupedLifeId);
    // A computed alias is mentionable as well …
    const hostMention = await resolveBridgeAddressee(db, {
      companyId: groupedCompanyId,
      text: "@host ping",
      endpointAgentId: groupedInfraId,
    });
    expect(hostMention?.agentId).toBe(groupedBbqHostId);

    // Computed on read only: the card keeps the data the board put there.
    const [card] = await db
      .select({ metadata: agents.metadata, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, groupedWorkId));
    expect(card?.metadata ?? null).toBeNull();
    expect(card?.adapterConfig).toEqual({});

    // In a chat turn /to picks the computed alias up …
    const { issue, boardUserId } = await createTelegramConversation({
      companyId: groupedCompanyId,
      agentId: groupedInfraId,
    });
    const toText = await replyOf(
      baseInput({
        companyId: groupedCompanyId,
        agentId: groupedInfraId,
        conversationIssueId: issue.id,
        boardUserId,
        text: "/to 2-2",
      }),
    );
    expect(toText).toContain("work-runner-2");
    expect(readStickyAgentId(await readOverrides(issue.id))).toBe(groupedWorkId);
  });

  it("17. the paused card is out of the default list and comes back when asked for", async () => {
    const names = (await listCompanyAddressableAgents(db, groupedCompanyId)).map((card) => card.name);
    expect(names).toContain("bbq-host");
    for (const hidden of ["bbq-editor", "legacy-bot-retired", "Wiki Maintainer", "work-gone"]) {
      expect(names).not.toContain(hidden);
    }

    const withPaused = (await listCompanyAddressableAgents(db, groupedCompanyId, { includePaused: true })).map(
      (card) => card.name,
    );
    expect(withPaused).toContain("bbq-editor");
    expect(withPaused).not.toContain("work-gone");
  });

  it("18. the grouped list renders from the Russian catalog", async () => {
    const text = await buildAgentsReplyText(db, {
      companyId: groupedCompanyId,
      conversationAgentId: groupedInfraId,
      stickyAgentId: null,
      locale: "ru",
    });
    expect(text).toContain(t("ru", "agents.groupHeader", { group: t("ru", "agents.group.infra") }));
    expect(text).toContain(
      t("ru", "agents.groupHeaderPaused", { group: t("ru", "agents.group.bbq"), count: 1 }),
    );
    expect(text).toContain(
      t("ru", "agents.lineNoRole", { name: "bbq-host", status: t("ru", "agents.status.idle"), aliases: "host" }),
    );
    expect(text).toContain(
      t("ru", "agents.lineNoRole", { name: "qa17", status: t("ru", "agents.status.running"), aliases: "qa17" }),
    );
  });
});

describe("computed default aliases (OPE-6318 part A)", () => {
  it("1. the alias is the last name segment, latin letters and digits only", () => {
    expect(defaultAliasFromName("adm-dev-eng-15")).toBe("15");
    expect(defaultAliasFromName("Agent-7")).toBe("7");
    expect(defaultAliasFromName("dispatch")).toBe("dispatch");
    expect(defaultAliasFromName("Wiki Maintainer")).toBe("wikimaintainer");
    // Nothing latin to build one from: no alias, never an empty handle.
    expect(defaultAliasFromName("bbq-юнит")).toBe("");
    expect(defaultAliasFromName("")).toBe("");
  });

  it("2. an explicit alias is reserved first, and a collision gets the -2, -3 suffix", () => {
    const aliased = addDefaultAliases([
      { name: "a-x", aliases: [] as string[] },
      { name: "b-x", aliases: [] },
      { name: "c-x", aliases: ["x"] },
      { name: "d", aliases: [] },
    ]);
    // "x" belongs to the card that set it explicitly …
    expect(aliased[2]!.aliases).toEqual(["x"]);
    // … so the two cards that wanted it take the numbered suffixes, in name order.
    expect(aliased[0]!.aliases).toEqual(["x-2"]);
    expect(aliased[1]!.aliases).toEqual(["x-3"]);
    expect(aliased[3]!.aliases).toEqual(["d"]);
  });

  it("3. a computed alias never shadows another agent's name", () => {
    const cards = addDefaultAliases([
      { name: "a-life", aliases: [] as string[] },
      { name: "life", aliases: [] },
    ]);
    expect(cards[0]!.aliases).toEqual(["life-2"]);
    // The agent actually named `life` keeps its own name as a handle.
    expect(cards[1]!.aliases).toEqual(["life"]);
  });
});
