// myrmidon(1.6.5 OPE-6318 part B): /agents with inline buttons.
//
// Two layers. The screens are pure — they are built from card fixtures (83
// agents, the size of the live fleet) and checked for what the owner sees:
// the directions as buttons, ten agents a page, an agent's own actions, and
// the Telegram limits (12 actions a card, 64 bytes of callback data). The
// button actions and the click proof run against a real database: choosing an
// agent writes the same sticky addressee `/to` writes, stopping stops that
// agent's runs in this chat only, and a click the bridge did not issue — or
// another person's — changes nothing.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatPublications,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import {
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "../../../services/chat-interaction-publications.js";
import { resolveAgentGroup } from "../grouping.js";
import { telegramConversationUserId } from "../identity.js";
import { t } from "../locales/index.js";
import type { CompanyAgentCard } from "./agents.js";
import {
  AGENTS_BUTTON_ACTION_KIND,
  AGENTS_MAX_CARD_BUTTONS,
  AGENTS_PAGE_SIZE,
  buildAgentScreen,
  buildGroupScreen,
  buildGroupsScreen,
  createAgentsButtonToken,
  parseAgentsButtonPayload,
  resolveAgentsButtonClick,
  runAgentsButtonAction,
  stageAgentsScreenPublication,
  type AgentsScreen,
  type StageTaskControlPublication,
} from "./agents-buttons.js";
import { runBridgedDirectMessageCommand, type BridgedCommandInput } from "./index.js";

// ---------------------------------------------------------------- pure screens

function card(
  name: string,
  status: string,
  extra: Partial<CompanyAgentCard> = {},
): CompanyAgentCard {
  return {
    id: randomUUID(),
    name,
    title: null,
    status,
    group: resolveAgentGroup(name, null),
    aliases: [],
    retired: false,
    service: false,
    ...extra,
  };
}

/** The live fleet's size and shape: 83 cards, four directions, hidden ones among them. */
function fleet(): CompanyAgentCard[] {
  const cards: CompanyAgentCard[] = [];
  for (let index = 1; index <= 41; index += 1) {
    cards.push(card(`adm-dev-eng-${String(index).padStart(2, "0")}`, index % 5 === 0 ? "running" : "idle"));
  }
  for (let index = 1; index <= 9; index += 1) cards.push(card(`adm-lead-${index}`, "idle"));
  for (let index = 1; index <= 14; index += 1) cards.push(card(`bbq-agent-${index}`, "idle"));
  for (let index = 1; index <= 8; index += 1) cards.push(card(`work-agent-${index}`, "idle"));
  for (const name of ["dispatch", "qa17", "life", "Wiki Maintainer"]) {
    cards.push(card(name, "idle", name === "Wiki Maintainer" ? { service: true } : {}));
  }
  cards.push(card("bbq-editor-retired", "idle", { retired: true }));
  cards.push(card("adm-paused-1", "paused"), card("adm-paused-2", "paused"), card("work-paused", "paused"));
  cards.push(card("bbq-gone", "terminated"), card("work-pending", "pending_approval"));
  return cards;
}

const everyAction = (screen: AgentsScreen) => screen.buttons.map((button) => button.action);

describe("/agents buttons: the screens", () => {
  const cards = fleet();
  const infra = t("en", "agents.group.infra");

  it("opens with the live directions as buttons, counting only the live agents", () => {
    const screen = buildGroupsScreen(cards, cards[0]!.id, "en");
    expect(screen.buttons.length).toBeLessThanOrEqual(6);
    expect(screen.buttons.map((button) => button.label)).toEqual([
      // the current addressee's direction first, then alphabetical
      `${infra} (50)`,
      `${t("en", "agents.group.bbq")} (14)`,
      `${t("en", "agents.group.other")} (3)`,
      `${t("en", "agents.group.work")} (8)`,
    ]);
    expect(everyAction(screen)[0]).toEqual({ op: "group", group: infra, page: 0 });
    // the hidden ones are named in the text, not listed: two paused in infra
    expect(screen.text).toContain(t("en", "agents.buttons.groupLinePaused", { group: infra, count: 50, paused: 2 }));
    expect(screen.text).not.toContain("adm-paused");
    expect(screen.text).not.toContain("retired");
  });

  it("shows ten agents a page, a button for each, and walks round the pages with 'more'", () => {
    const first = buildGroupScreen(cards, "", "en", infra, 0)!;
    const agentButtons = first.buttons.filter((button) => button.action.op === "agent");
    expect(agentButtons).toHaveLength(AGENTS_PAGE_SIZE);
    expect(first.buttons).toHaveLength(AGENTS_PAGE_SIZE + 2); // + more + back
    expect(first.text).toContain(t("en", "agents.buttons.page", { page: 1, pages: 5 }));

    const more = first.buttons.find((button) => button.label === t("en", "agents.buttons.more"))!;
    expect(more.action).toEqual({ op: "group", group: infra, page: 1 });
    const last = buildGroupScreen(cards, "", "en", infra, 4)!;
    expect(last.buttons.filter((button) => button.action.op === "agent")).toHaveLength(50 - 4 * AGENTS_PAGE_SIZE);
    expect(last.buttons.find((button) => button.label === t("en", "agents.buttons.more"))!.action).toEqual({
      op: "group",
      group: infra,
      page: 0,
    });
    // a page past the end reads as the first page, a vanished direction as nothing
    expect(buildGroupScreen(cards, "", "en", infra, 99)!.text).toContain(
      t("en", "agents.buttons.page", { page: 1, pages: 5 }),
    );
    expect(buildGroupScreen(cards, "", "en", "No such direction", 0)).toBeNull();
  });

  it("never lists a paused, retired, service, terminated or pending card on any page", () => {
    const hidden = cards.filter((entry) => entry.status !== "idle" && entry.status !== "running" || entry.retired || entry.service);
    const everything = [
      buildGroupsScreen(cards, "", "en"),
      ...[infra, t("en", "agents.group.bbq"), t("en", "agents.group.work"), t("en", "agents.group.other")].flatMap((group) =>
        [0, 1, 2, 3, 4].map((page) => buildGroupScreen(cards, "", "en", group, page)).filter((s) => s !== null),
      ),
    ] as AgentsScreen[];
    for (const screen of everything) {
      for (const entry of hidden) {
        expect(screen.text).not.toContain(entry.name);
        expect(screen.buttons.map((button) => button.label)).not.toContain(entry.name);
        for (const action of everyAction(screen)) {
          if ("agentId" in action) expect(action.agentId).not.toBe(entry.id);
        }
      }
      // Telegram limits: at most 12 actions a card, labels short enough to read
      expect(screen.buttons.length).toBeLessThanOrEqual(AGENTS_MAX_CARD_BUTTONS);
      for (const button of screen.buttons) expect(button.label.length).toBeLessThanOrEqual(80);
    }
  });

  it("gives an agent its own card: write, model, stop, and the way back to its page", () => {
    const target = cards.find((entry) => entry.name === "adm-dev-eng-27")!;
    const screen = buildAgentScreen(cards, "", "en", target.id)!;
    expect(everyAction(screen)).toEqual([
      { op: "pick", agentId: target.id },
      { op: "model", agentId: target.id },
      { op: "stop", agentId: target.id },
      { op: "group", group: infra, page: 2 }, // 30th in its direction (running first): the third page
    ]);
    expect(screen.title).toContain(target.name);
    // a card that is not live has no screen
    const paused = cards.find((entry) => entry.name === "adm-paused-1")!;
    expect(buildAgentScreen(cards, "", "en", paused.id)).toBeNull();
  });

  it("speaks the chat's language: Russian screens carry no English button text", () => {
    const screen = buildGroupsScreen(cards, "", "ru");
    expect(screen.text).toContain(t("ru", "agents.buttons.groupsIntro"));
    const group = buildGroupScreen(cards, "", "ru", t("ru", "agents.group.infra"), 0)!;
    expect(group.buttons.at(-1)!.label).toBe(t("ru", "agents.buttons.back"));
    expect(group.buttons.at(-1)!.label).not.toBe(t("en", "agents.buttons.back"));
  });

  it("keeps a button token inside Telegram's 64 bytes of callback data", () => {
    const token = createAgentsButtonToken();
    expect(Buffer.byteLength(telegramChatSdkCallbackData(token), "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
    expect(token).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
    expect(createAgentsButtonToken()).not.toBe(token);
  });

  it("reads back only the payloads it wrote", () => {
    const id = randomUUID();
    expect(parseAgentsButtonPayload({ op: "pick", agentId: id })).toEqual({ op: "pick", agentId: id });
    expect(parseAgentsButtonPayload({ op: "group", group: "x", page: 2 })).toEqual({ op: "group", group: "x", page: 2 });
    expect(parseAgentsButtonPayload({ op: "groups" })).toEqual({ op: "groups" });
    for (const junk of [
      null,
      "pick",
      [],
      {},
      { op: "pick" },
      { op: "pick", agentId: "not-a-uuid" },
      { op: "stop", agentId: `${id}x` },
      { op: "group", group: "", page: 0 },
      { op: "group", group: "x", page: -1 },
      { op: "group", group: "x", page: 1.5 },
      { op: "delete", agentId: id },
    ]) {
      expect(parseAgentsButtonPayload(junk)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- with a database

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("/agents buttons: actions and the click proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let mainId: string;
  let peerId: string;
  let runningPeerId: string;
  let pausedId: string;
  let strangerId: string;
  const noModelCatalog = async () => null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("myrmidon-agents-buttons-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    mainId = randomUUID();
    peerId = randomUUID();
    runningPeerId = randomUUID();
    pausedId = randomUUID();
    strangerId = randomUUID();
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
      { id: companyId, name: "Buttons Co", issuePrefix: "BTN", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Buttons Other Co", issuePrefix: "BTO", requireBoardApprovalForNewAgents: false },
    ]);
    const base = { role: "engineer", adapterType: "hermes_local", adapterConfig: {} };
    await db.insert(agents).values([
      { ...base, id: mainId, companyId, name: "adm-main", status: "idle", adapterConfig: { model: "model-main" } },
      { ...base, id: peerId, companyId, name: "adm-peer", status: "idle", adapterConfig: { model: "model-peer" } },
      { ...base, id: runningPeerId, companyId, name: "bbq-runner", status: "running" },
      { ...base, id: pausedId, companyId, name: "adm-sleeper", status: "paused" },
      { ...base, id: strangerId, companyId: otherCompanyId, name: "adm-stranger", status: "idle" },
    ]);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function telegramConversation(boardUserId = randomUUID()) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Telegram chat",
        conversationAgentId: mainId,
        conversationUserId: telegramConversationUserId(boardUserId),
        assigneeAgentId: mainId,
        status: "in_review",
        conversationState: "waiting",
      })
      .returning();
    return { issue: issue!, boardUserId };
  }

  async function stickyOf(issueId: string) {
    const [row] = await db
      .select({ overrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, issueId));
    return ((row?.overrides as Record<string, unknown> | null) ?? {}).telegramStickyAgentId ?? null;
  }

  function actionInput(
    conversation: { issue: { id: string }; boardUserId: string },
    action: Parameters<typeof runAgentsButtonAction>[0]["action"],
    cancelRun: BridgedCommandInput["cancelRun"] = async () => ({}),
  ): Parameters<typeof runAgentsButtonAction>[0] {
    return {
      db,
      companyId,
      conversationAgentId: mainId,
      conversationIssueId: conversation.issue.id,
      boardUserId: conversation.boardUserId,
      action,
      cancelRun,
      readGatewayModelCatalog: noModelCatalog,
    };
  }

  it("choosing an agent makes it the sticky addressee, exactly as /to does", async () => {
    const viaButton = await telegramConversation();
    const screen = await runAgentsButtonAction(actionInput(viaButton, { op: "pick", agentId: peerId }));
    expect(await stickyOf(viaButton.issue.id)).toBe(peerId);
    expect(screen.text).toContain("adm-peer");

    // the same write /to <alias> makes on a twin conversation
    const viaCommand = await telegramConversation();
    const reply = await runBridgedDirectMessageCommand({
      db,
      companyId,
      agentId: mainId,
      endpointId: "endpoint-a",
      deliveryId: randomUUID(),
      boardUserId: viaCommand.boardUserId,
      conversationIssueId: viaCommand.issue.id,
      text: `/to ${peerId}`,
      publicBaseUrl: null,
      cancelRun: async () => ({}),
    });
    expect(reply?.kind).toBe("reply");
    expect(await stickyOf(viaCommand.issue.id)).toBe(await stickyOf(viaButton.issue.id));
    expect((reply as { text: string }).text).toBe(screen.text);
  });

  it("refuses to choose a paused agent, one of another company, or anyone but the conversation's owner", async () => {
    const own = await telegramConversation();
    for (const agentId of [pausedId, strangerId, randomUUID()]) {
      const screen = await runAgentsButtonAction(actionInput(own, { op: "pick", agentId }));
      expect(screen.text).toBe(t("en", "agents.buttons.unavailable"));
      expect(await stickyOf(own.issue.id)).toBeNull();
    }

    const intruder = { issue: own.issue, boardUserId: randomUUID() };
    const refused = await runAgentsButtonAction(actionInput(intruder, { op: "pick", agentId: peerId }));
    expect(refused.text).toBe(t("en", "chat.notAvailable"));
    expect(refused.buttons).toEqual([]);
    expect(await stickyOf(own.issue.id)).toBeNull();
  });

  it("'stop' cancels the chosen agent's runs in this chat, and nothing else", async () => {
    const own = await telegramConversation();
    const elsewhere = await telegramConversation();
    const [mine] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: runningPeerId, status: "running", contextSnapshot: { issueId: own.issue.id } })
      .returning();
    await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: runningPeerId, status: "running", contextSnapshot: { issueId: elsewhere.issue.id } });
    await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: peerId, status: "running", contextSnapshot: { issueId: own.issue.id } });

    const cancelled: string[] = [];
    const screen = await runAgentsButtonAction(
      actionInput(own, { op: "stop", agentId: runningPeerId }, async (runId) => {
        cancelled.push(runId);
        return {};
      }),
    );
    expect(cancelled).toEqual([mine!.id]);
    expect(screen.text).toBe(t("en", "stop.stopping"));

    // nothing running for that agent in this chat: say so, cancel nothing
    const idle = await runAgentsButtonAction(
      actionInput(elsewhere, { op: "stop", agentId: mainId }, async (runId) => {
        cancelled.push(runId);
        return {};
      }),
    );
    expect(idle.text).toBe(t("en", "stop.idle"));
    expect(cancelled).toHaveLength(1);

    // a cancel that fails is reported, not thrown
    const failing = await runAgentsButtonAction(
      actionInput(own, { op: "stop", agentId: runningPeerId }, async () => {
        throw new Error("boom");
      }),
    );
    expect(failing.text).toBe(t("en", "stop.unavailable"));

    // someone else's click stops nothing
    const intruderCancelled: string[] = [];
    await runAgentsButtonAction(
      actionInput({ issue: own.issue, boardUserId: randomUUID() }, { op: "stop", agentId: runningPeerId }, async (runId) => {
        intruderCancelled.push(runId);
        return {};
      }),
    );
    expect(intruderCancelled).toEqual([]);
  });

  it("'model' shows the chosen agent's model, not the conversation agent's", async () => {
    const own = await telegramConversation();
    const screen = await runAgentsButtonAction(actionInput(own, { op: "model", agentId: peerId }));
    expect(screen.text).toContain("model-peer");
    expect(screen.text).not.toContain("model-main");
  });

  it("walks the dialog: directions, a direction, an agent", async () => {
    const own = await telegramConversation();
    const groups = await runAgentsButtonAction(actionInput(own, { op: "groups" }));
    expect(groups.buttons.length).toBeGreaterThan(0);
    const infraButton = groups.buttons.find((button) => button.label.startsWith(t("en", "agents.group.infra")))!;
    const group = await runAgentsButtonAction(actionInput(own, infraButton.action));
    const peerButton = group.buttons.find((button) => button.label === "adm-peer")!;
    const agent = await runAgentsButtonAction(actionInput(own, peerButton.action));
    expect(everyAction(agent).map((action) => action.op)).toEqual(["pick", "model", "stop", "group"]);
    // the paused card is in no list
    expect(group.text).not.toContain("adm-sleeper");
  });

  it("/agents answers with the directions as buttons; /agents text keeps the plain list", async () => {
    const own = await telegramConversation();
    const run = (text: string) =>
      runBridgedDirectMessageCommand({
        db,
        companyId,
        agentId: mainId,
        endpointId: "endpoint-a",
        deliveryId: randomUUID(),
        boardUserId: own.boardUserId,
        conversationIssueId: own.issue.id,
        text,
        publicBaseUrl: null,
        cancelRun: async () => ({}),
      });

    const buttons = await run("/agents");
    expect(buttons?.kind).toBe("reply");
    const withScreen = buttons as { kind: "reply"; command: string; text: string; screen?: AgentsScreen };
    expect(withScreen.command).toBe("agents");
    expect(withScreen.screen?.buttons.length).toBeGreaterThan(0);
    expect(withScreen.screen?.buttons.length).toBeLessThanOrEqual(6);
    expect(withScreen.text).toContain(withScreen.screen!.text);

    const plain = (await run("/agents text")) as { kind: "reply"; text: string; screen?: AgentsScreen };
    expect(plain.screen).toBeUndefined();
    expect(plain.text).toContain(t("en", "agents.header"));
    expect(plain.text).toContain("adm-peer");

    // someone else's conversation gets neither
    const refused = (await runBridgedDirectMessageCommand({
      db,
      companyId,
      agentId: mainId,
      endpointId: "endpoint-a",
      deliveryId: randomUUID(),
      boardUserId: randomUUID(),
      conversationIssueId: own.issue.id,
      text: "/agents",
      publicBaseUrl: null,
      cancelRun: async () => ({}),
    })) as { kind: "reply"; text: string; screen?: AgentsScreen };
    expect(refused.text).toBe(t("en", "chat.notAvailable"));
    expect(refused.screen).toBeUndefined();
  });

  // ------------------------------------------------------------ staging and the click proof

  async function seedEndpoint() {
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
      provider: "telegram",
      publicId: randomUUID(),
      assignedAgentId: mainId,
      status: "active",
    });
    return endpointId;
  }

  async function stagedScreen(options: { now?: Date } = {}) {
    const endpointId = await seedEndpoint();
    const own = await telegramConversation();
    const threadId = `telegram:${Math.floor(Math.random() * 1e9)}`;
    const [conversation] = await db
      .insert(chatConversations)
      .values({
        companyId,
        endpointId,
        issueId: own.issue.id,
        externalConversationId: threadId,
        externalThreadId: threadId,
        externalLabel: "Telegram DM",
        isDirectMessage: true,
        state: "active",
      })
      .returning();
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId,
        provider: "telegram",
        providerAccountId: `acct-${endpointId}`,
        externalId: String(Math.floor(Math.random() * 1e9) + 1),
        kind: "user",
        displayName: "Telegram User",
        handle: "telegram-user",
        isBot: false,
        lastSeenAt: new Date(),
      })
      .returning({ id: chatExternalPrincipals.id });
    const staged: SafeChatPublicationPayload[] = [];
    const stage: StageTaskControlPublication = async (tx, input) => {
      staged.push(input.payload);
      const [row] = await tx
        .insert(chatPublications)
        .values({
          companyId: input.companyId,
          endpointId: input.endpointId,
          conversationId: input.conversationId,
          issueId: input.issueId,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
          state: "published",
          providerMessageId: "7001",
        })
        .returning({ id: chatPublications.id });
      return row!;
    };
    const screen = await buildGroupsScreenFor(own);
    const publication = await stageAgentsScreenPublication({
      tx: db,
      stage,
      companyId,
      endpointId,
      conversationId: conversation!.id,
      issueId: own.issue.id,
      principalId: principal!.id,
      idempotencyKey: `control:x8-agents:${randomUUID()}`,
      screen,
      now: options.now,
    });
    const rows = await db
      .select()
      .from(chatActions)
      .where(and(eq(chatActions.endpointId, endpointId), eq(chatActions.kind, AGENTS_BUTTON_ACTION_KIND)));
    return { endpointId, own, conversation: conversation!, publication, payload: staged[0]!, rows, threadId, screen };
  }

  async function buildGroupsScreenFor(own: Awaited<ReturnType<typeof telegramConversation>>) {
    const screen = await runAgentsButtonAction(actionInput(own, { op: "groups" }));
    return screen;
  }

  function click(
    fixture: Awaited<ReturnType<typeof stagedScreen>>,
    overrides: Partial<Parameters<typeof resolveAgentsButtonClick>[1]> = {},
  ) {
    const actionId = fixture.rows[0]!.providerActionId;
    return resolveAgentsButtonClick(db, {
      endpointId: fixture.endpointId,
      companyId,
      actionId,
      threadId: fixture.threadId,
      messageId: "7001",
      rawData: telegramChatSdkCallbackData(actionId),
      value: undefined,
      threadMatches: (a, b) => a === b,
      ...overrides,
    });
  }

  it("publishes the screen as a card of callback buttons and issues one live token for each", async () => {
    const fixture = await stagedScreen();
    const actions = fixture.payload.card?.actions ?? [];
    expect(fixture.payload.interactionId).toBeUndefined();
    expect(actions.length).toBe(fixture.screen.buttons.length);
    expect(actions.length).toBeGreaterThan(0);
    expect(fixture.rows).toHaveLength(actions.length);
    for (const action of actions) {
      expect(action.type).toBe("callback");
      if (action.type !== "callback") continue;
      expect(Buffer.byteLength(telegramChatSdkCallbackData(action.actionId), "utf8")).toBeLessThanOrEqual(
        TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
      );
      const row = fixture.rows.find((entry) => entry.providerActionId === action.actionId)!;
      expect(row.status).toBe("issued");
      expect(row.conversationId).toBe(fixture.conversation.id);
      expect(row.payload.publicationId).toBe(fixture.publication.id);
    }
  });

  it("accepts a click on the message the token was issued for, with exactly Telegram's callback data", async () => {
    const fixture = await stagedScreen();
    const resolved = await click(fixture);
    expect(resolved.kind).toBe("ok");
    if (resolved.kind !== "ok") return;
    expect(resolved.conversation.id).toBe(fixture.conversation.id);
    expect(resolved.expired).toBe(false);
    expect(resolved.action).toEqual(parseAgentsButtonPayload(fixture.rows[0]!.payload.action));
  });

  it("refuses a click that is not the one the bridge issued", async () => {
    const fixture = await stagedScreen();
    const actionId = fixture.rows[0]!.providerActionId;
    const denied = async (overrides: Partial<Parameters<typeof resolveAgentsButtonClick>[1]>) =>
      expect((await click(fixture, overrides)).kind).toBe("deny");

    await denied({ actionId: "pca:never-issued" });
    await denied({ messageId: "7002" }); // another message
    await denied({ threadId: "telegram:1" }); // another chat
    await denied({ rawData: telegramChatSdkCallbackData("pca:forged") });
    await denied({ rawData: null });
    await denied({ rawData: `${telegramChatSdkCallbackData(actionId)} ` });
    await denied({ value: "anything" });
    await denied({ endpointId: await seedEndpoint() }); // another bot

    await db
      .update(chatActions)
      .set({ status: "expired" })
      .where(eq(chatActions.providerActionId, actionId));
    await denied({});
  });

  it("marks a token past its ten minutes as expired, for a soft refusal", async () => {
    const fixture = await stagedScreen({ now: new Date(Date.now() - 11 * 60 * 1_000) });
    const resolved = await click(fixture);
    expect(resolved.kind).toBe("ok");
    if (resolved.kind === "ok") expect(resolved.expired).toBe(true);
  });

  it("ties a token to its conversation: a closed conversation's buttons do nothing", async () => {
    const fixture = await stagedScreen();
    await db
      .update(chatConversations)
      .set({ state: "completed" })
      .where(eq(chatConversations.id, fixture.conversation.id));
    expect((await click(fixture)).kind).toBe("deny");
  });
});
