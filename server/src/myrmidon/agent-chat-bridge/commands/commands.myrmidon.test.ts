// myrmidon(X8c): OpenClaw-style commands in a bridged Telegram direct
// message conversation. Red on pre-X8c main: X8a's `runBridgedDirectMessageCommand`
// is a `/new`/`/reset`-only stand-in, and `./context.js`, `./help.js`,
// `./models.js`, `./overrides.js`, `./status.js`, `./stop.js` do not exist there.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  userUiLanguage,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { telegramConversationUserId } from "../identity.js";
import {
  TELEGRAM_DM_COMMANDS,
  parseBridgedCommand,
  runBridgedDirectMessageCommand,
  type BridgedCommandInput,
} from "./index.js";
import { applyChatAdapterOverride } from "./overrides.js";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("bridged Telegram DM commands (X8c)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let gatewayAgentId: string;
  let glmAgentId: string;
  let otherGatewayAgentId: string;
  let sentinelAgentId: string;

  beforeAll(async () => {
    process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
      hermes_local: [{ id: "model-c" }],
    });

    database = await startEmbeddedPostgresTestDatabase("myrmidon-x8c-commands-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    gatewayAgentId = randomUUID();
    glmAgentId = randomUUID();
    otherGatewayAgentId = randomUUID();
    sentinelAgentId = randomUUID();

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
    await db.insert(companies).values({
      id: companyId,
      name: "X8c Test Co",
      issuePrefix: "X8C",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent A",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: { model: "model-a", models: { fallbacks: ["model-b"] } },
    });
    await db.insert(agents).values({
      id: gatewayAgentId,
      companyId,
      name: "Agent B (gateway)",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    });
    // myrmidon(F06-A): a gateway agent whose model is a GLM one — its effort
    // list is the narrow one effort-policy.ts declares (low/high/max).
    await db.insert(agents).values({
      id: glmAgentId,
      companyId,
      name: "Agent D (gateway, glm)",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: { model: "glm-4.6" },
    });
    // An agent on an adapter that neither allowlist covers (the sibling
    // gateway adapter) — the /model and /think refusal path.
    await db.insert(agents).values({
      id: otherGatewayAgentId,
      companyId,
      name: "Agent E (openclaw gateway)",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    });
    // A card whose own model/fallbacks are the adapter's "let it decide"
    // sentinels (ADAPTER_SPECIAL_MODEL_VALUES) rather than real model names.
    await db.insert(agents).values({
      id: sentinelAgentId,
      companyId,
      name: "Agent C (sentinel card)",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: { model: "default", models: { fallbacks: ["auto", "model-b"] } },
    });
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
      executionRunId?: string | null;
    } = {},
  ) {
    const conversationAgentId = options.agentId ?? agentId;
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
        executionRunId: options.executionRunId ?? null,
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
        conversationAgentId: agentId,
        conversationUserId: boardUserId,
        assigneeAgentId: agentId,
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
      agentId,
      endpointId: "endpoint-a",
      deliveryId: randomUUID(),
      publicBaseUrl: null,
      cancelRun: noopCancelRun(),
      ...overrides,
    };
  }

  async function readOverrides(issueId: string) {
    const [row] = await db
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, issueId));
    return (row?.assigneeAdapterOverrides as Record<string, unknown> | null) ?? null;
  }

  async function hasSessionRow(issueId: string, forAgentId = agentId) {
    const rows = await db
      .select({ id: agentTaskSessions.id })
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, forAgentId), eq(agentTaskSessions.taskKey, issueId)));
    return rows.length > 0;
  }

  it("1. /model lists the card model, its fallback and the discovered model, with the current one identified", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model" }),
    );
    expect(result?.kind).toBe("reply");
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("Model: model-a (agent default)");
    expect(text).toMatch(/1\)\s*model-a/);
    expect(text).toMatch(/2\)\s*model-b/);
    expect(text).toMatch(/3\)\s*model-c/);
  });

  it("1b. /model and /status never show the adapter's own 'default'/'auto' sentinels as a chosen model", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: sentinelAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, agentId: sentinelAgentId, text: "/model" }),
    );
    expect(result?.kind).toBe("reply");
    const text = (result as { kind: "reply"; text: string }).text;
    // Neither the card's "default" model nor its "auto" fallback is a real
    // choice; only model-b (a real fallback) and model-c (discovered) are.
    expect(text).toContain("Model: adapter default (adapter default)");
    expect(text).not.toMatch(/\)\s*default\b/i);
    expect(text).not.toMatch(/\)\s*auto\b/i);
    expect(text).toMatch(/1\)\s*model-b/);
    expect(text).toMatch(/2\)\s*model-c/);

    const status = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, agentId: sentinelAgentId, text: "/status" }),
    );
    const statusText = (status as { kind: "reply"; text: string }).text;
    expect(statusText).toContain("Model: adapter default (adapter default)");
  });

  it("2. /model model-b sets the override, keeps other override keys, drops the session and logs the change", async () => {
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "hermes_local",
      taskKey: "placeholder",
    });
    const { issue, boardUserId } = await createTelegramConversation({
      assigneeAdapterOverrides: { adapterConfig: { effort: "high" }, useProjectWorkspace: true },
    });
    await db.update(agentTaskSessions).set({ taskKey: issue.id }).where(eq(agentTaskSessions.taskKey, "placeholder"));
    expect(await hasSessionRow(issue.id)).toBe(true);

    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model model-b" }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "model",
      outcome: "applied",
      text: "Model for this chat: model-b. The next reply starts a new model session with this chat's recent history.",
    });

    const overrides = await readOverrides(issue.id);
    expect(overrides).toEqual({
      adapterConfig: { effort: "high", model: "model-b" },
      useProjectWorkspace: true,
    });
    expect(await hasSessionRow(issue.id)).toBe(false);

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.updated")));
    expect(activity).toBeTruthy();
    expect(activity!.actorType).toBe("user");
    expect(activity!.actorId).toBe(boardUserId);
    expect(activity!.details).toMatchObject({
      source: "chat:telegram",
      conversationOverride: { key: "model", value: "model-b" },
    });
  });

  it("3. /model accepts a 1-based index and is case-insensitive on names", async () => {
    const byIndex = await createTelegramConversation();
    const byIndexResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: byIndex.issue.id, boardUserId: byIndex.boardUserId, text: "/model 3" }),
    );
    expect(byIndexResult).toMatchObject({ kind: "reply", text: expect.stringContaining("Model for this chat: model-c.") });

    const byName = await createTelegramConversation();
    const byNameResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: byName.issue.id, boardUserId: byName.boardUserId, text: "/model MODEL-B" }),
    );
    expect(byNameResult).toMatchObject({ kind: "reply", text: expect.stringContaining("Model for this chat: model-b.") });
  });

  it("4. /model nope is rejected and changes nothing", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model nope" }),
    );
    expect(result).toMatchObject({ kind: "reply", command: "model", text: expect.stringContaining('Unknown model “nope”.') });
    expect(await readOverrides(issue.id)).toBeNull();
  });

  it("5. /model is refused while this conversation has a run in progress", async () => {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running" })
      .returning();
    const { issue, boardUserId } = await createTelegramConversation({ executionRunId: run!.id });

    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model model-b" }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "model",
      outcome: "refused",
      text: "A reply is in progress right now. Try after it finishes or send /stop.",
    });
    expect(await readOverrides(issue.id)).toBeNull();
  });

  it("5b. applyChatAdapterOverride re-checks turnInProgress at write time (review round 2, minor)", async () => {
    // Reproduces the narrow window between a command handler's earlier
    // turnInProgress read (loadBridgedCommandContext, before argument
    // resolution) and applyChatAdapterOverride's own write: a run that starts
    // in between must still block a /model or /think write, so the check is
    // repeated here, inside the row lock, against a freshly read
    // executionRunId/heartbeat_runs state — not just trusted from earlier.
    const { issue, boardUserId } = await createTelegramConversation();
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "hermes_local", taskKey: issue.id });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });

    const refused = await applyChatAdapterOverride({
      db,
      companyId,
      conversationAgentId: agentId,
      issueId: issue.id,
      boardUserId,
      key: "model",
      value: "model-b",
      refuseIfTurnInProgress: true,
    });
    expect(refused).toEqual({ applied: false });
    expect(await readOverrides(issue.id)).toBeNull();
    // The refusal must not touch the session either — only a successful
    // apply resets it.
    expect(await hasSessionRow(issue.id)).toBe(true);

    // /new's own call passes refuseIfTurnInProgress: false and must still
    // apply — it targets the fresh session it is about to start, not
    // whatever is currently running (index.ts's handleNewCommand).
    const applied = await applyChatAdapterOverride({
      db,
      companyId,
      conversationAgentId: agentId,
      issueId: issue.id,
      boardUserId,
      key: "model",
      value: "model-b",
      refuseIfTurnInProgress: false,
    });
    expect(applied).toEqual({ applied: true });
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "model-b" } });
    expect(await hasSessionRow(issue.id)).toBe(false);
  });

  it("5c. a gateway model chosen for a native-provider card is written with a matching provider (F06-D)", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const card = { provider: "anthropic", model: "claude-own" };
    const base = {
      db,
      companyId,
      conversationAgentId: agentId,
      issueId: issue.id,
      boardUserId,
      key: "model" as const,
      refuseIfTurnInProgress: false,
      adapterType: "hermes_gateway",
      adapterConfig: card,
      botApply: { apply: async () => ({ kind: "applied_files" as const }) },
    };
    // A model from the gateway catalog: the pair must not be anthropic + zai-glm.
    await applyChatAdapterOverride({ ...base, value: "zai-glm-5.3" });
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "zai-glm-5.3", provider: "custom" } });
    // The card's own model keeps the card's provider: no provider override.
    await applyChatAdapterOverride({ ...base, value: "claude-own" });
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "claude-own" } });
    // Back to a gateway model, then to the agent default: both keys go.
    await applyChatAdapterOverride({ ...base, value: "zai-glm-5.3" });
    await applyChatAdapterOverride({ ...base, value: null });
    expect(await readOverrides(issue.id)).toBeNull();
    // A failed apply rolls the pair back together.
    await applyChatAdapterOverride({ ...base, value: "claude-own" });
    const failed = await applyChatAdapterOverride({
      ...base,
      value: "zai-glm-5.3",
      botApply: { apply: async () => ({ kind: "error" as const, message: "boom" }) },
    });
    expect(failed).toMatchObject({ applied: true, botApply: { kind: "error", rolledBack: true } });
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "claude-own" } });
  });

  it("5d. a card that already goes through the gateway gets no provider override (F06-D)", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    for (const card of [{}, { provider: "auto" }, { provider: "custom:litellm" }]) {
      await applyChatAdapterOverride({
        db,
        companyId,
        conversationAgentId: agentId,
        issueId: issue.id,
        boardUserId,
        key: "model",
        value: "zai-glm-5.3",
        refuseIfTurnInProgress: false,
        adapterType: "hermes_gateway",
        adapterConfig: card,
        botApply: { apply: async () => ({ kind: "applied_files" }) },
      });
      expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "zai-glm-5.3" } });
    }
  });

  it("6. /model default clears the override, dropping an empty adapterConfig entirely", async () => {
    const { issue, boardUserId } = await createTelegramConversation({
      assigneeAdapterOverrides: { adapterConfig: { model: "model-b" } },
    });
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model default" }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "model",
      outcome: "applied",
      text: "Model for this chat: agent default (model-a).",
    });
    expect(await readOverrides(issue.id)).toBeNull();
  });

  it("7. /model lists the gateway catalog for hermes_gateway, grouped by provider family", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const applied: string[] = [];
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model",
        readGatewayModelCatalog: async () => ({
          models: ["zai-glm-4.6", "dashscope-qwen3-max", "nous-hermes-4"],
          providers: {
            "zai-glm-4.6": "zai",
            "dashscope-qwen3-max": "dashscope",
            "nous-hermes-4": "nous",
          },
          scope: "agentKey",
        }),
        botContainerApply: {
          apply: async (agent) => {
            applied.push(agent.agentId);
            return { kind: "applied_files" };
          },
        },
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    // Numbered continuously. myrmidon(F06-D): the family order is the owner's
    // channel policy — DashScope first, then z.ai, then the rest alphabetically.
    // myrmidon(F06-D): no family header lines — one id per numbered line.
    expect(text).not.toContain("dashscope-*");
    expect(text).not.toContain("nous-*");
    expect(text).not.toContain("zai-*");
    expect(text).toMatch(/1\)\s*dashscope-qwen3-max/);
    expect(text).toMatch(/2\)\s*zai-glm-4\.6/);
    expect(text).toMatch(/3\)\s*nous-hermes-4/);
    // An agent's own key list was read, so nothing says it is the whole catalog.
    expect(text).not.toContain("whole gateway catalog");
    // Listing writes nothing, so nothing was applied either.
    expect(applied).toEqual([]);
    expect(await readOverrides(issue.id)).toBeNull();
  });

  it("7e. /model drops embeddings, OCR and service models from the gateway catalog (F06-D)", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model",
        readGatewayModelCatalog: async () => ({
          models: [
            "dashscope-qwen3-max",
            "dashscope-embed-v3",
            "dashscope-text-embedding-v4",
            "dashscope-ocr-vl",
            "zai-glm-4.6",
            "hindsight-mem",
            "hindsight-consolidation",
            "deepseek-v4-flash-mem",
          ],
          scope: "catalog",
        }),
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("dashscope-qwen3-max");
    expect(text).toContain("zai-glm-4.6");
    expect(text).not.toContain("embed");
    expect(text).not.toContain("ocr");
    expect(text).not.toContain("hindsight");
    expect(text).not.toContain("deepseek-v4-flash-mem");
    // DashScope before z.ai (owner channel policy).
    expect(text.indexOf("dashscope-qwen3-max")).toBeLessThan(text.indexOf("zai-glm-4.6"));
  });

  it("7f. a live-sized catalog lists every chat model: DashScope's, then z.ai's, then the rest (F06-D)", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const dashscope = Array.from({ length: 18 }, (_, i) => `dashscope-chat-${String(i + 1).padStart(2, "0")}`);
    const service = [
      "dashscope-text-embedding-v4",
      "dashscope-ocr",
      "dashscope-tts-flash",
      "dashscope-asr-flash",
      "dashscope-rerank-v3",
      "hindsight-mem",
      "hindsight-embed",
      "deepseek-v4-flash-mem",
    ];
    const zai = ["zai-glm-4.6", "zai-glm-4.7", "zai-glm-5.3", "zai-glm-5.3-flash"];
    const others = Array.from({ length: 12 }, (_, i) => `other-model-${String(i + 1).padStart(2, "0")}`);
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model",
        // Worst order for the old code: z.ai first, service ids in between.
        readGatewayModelCatalog: async () => ({
          models: [...others, ...zai.slice().reverse(), ...service, ...dashscope.slice().reverse()],
          scope: "catalog",
        }),
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    for (const id of [...dashscope, ...zai]) expect(text).toContain(id);
    for (const id of service) expect(text).not.toContain(id);
    // Every DashScope model before every z.ai one; z.ai in version order.
    expect(text.indexOf("dashscope-chat-18")).toBeLessThan(text.indexOf("zai-glm-4.6"));
    expect(text.indexOf("zai-glm-4.7")).toBeLessThan(text.indexOf("zai-glm-5.3\n"));
    expect(text).toMatch(/19\) zai-glm-4\.6/);
    expect(text).toMatch(/22\) zai-glm-5\.3-flash/);
    // Owner 09.10: no ceiling — the other families follow, all of them, and
    // nothing is reported as left out.
    for (const id of others) expect(text).toContain(id);
    expect(text).toMatch(/23\) other-model-01/);
    expect(text).toMatch(/34\) other-model-12/);
    expect(text).not.toMatch(/Buttons cover|…and \d+ more/);
    // Any of them can be chosen by name.
    const picked = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model other-model-05",
        readGatewayModelCatalog: async () => ({ models: [...others, ...zai, ...dashscope], scope: "catalog" }),
        botContainerApply: { apply: async () => ({ kind: "applied_files" }) },
      }),
    );
    expect((picked as { text: string }).text).toContain("Model for this chat: other-model-05.");
  });

  it("7g. the card's own model takes its place in the owner's channel order, not the head of the list (F06-D)", async () => {
    const [cardAgent] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        companyId,
        name: "Agent F (gateway, card model)",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_gateway",
        adapterConfig: { model: "nous-hermes-4" },
      })
      .returning();
    const { issue, boardUserId } = await createTelegramConversation({ agentId: cardAgent!.id });
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: cardAgent!.id,
        text: "/model",
        readGatewayModelCatalog: async () => ({
          models: ["nous-hermes-4", "zai-glm-4.6", "dashscope-qwen3-max"],
          scope: "agentKey",
        }),
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toMatch(/1\) dashscope-qwen3-max/);
    expect(text).toMatch(/2\) zai-glm-4\.6/);
    expect(text).toMatch(/3\) nous-hermes-4/);
  });

  it("7h. a whole-catalog list names why the agent's own list was not read (F06-D)", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model",
        readGatewayModelCatalog: async () => ({
          models: ["dashscope-qwen3-max"],
          scope: "catalog",
          keyFailure: "no_key",
        }),
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("whole gateway catalog");
    expect(text).toContain("Reason: no gateway key is bound to this agent.");
  });

  it("7b. /model <catalog model> writes the override and applies the agent profile without a restart", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const applied: Array<{ agentId: string; adapterType: string }> = [];
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model nous-hermes-4",
        readGatewayModelCatalog: async () => ({
          models: ["nous-hermes-4"],
          providers: { "nous-hermes-4": "nous" },
          scope: "agentKey",
        }),
        botContainerApply: {
          apply: async (agent) => {
            applied.push({ agentId: agent.agentId, adapterType: agent.adapterType });
            return { kind: "applied_files" };
          },
        },
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("Model for this chat: nous-hermes-4.");
    expect(text).toContain(
      "The agent profile is applied without a restart; the change takes effect from the next reply.",
    );
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "nous-hermes-4" } });
    expect(applied).toEqual([{ agentId: gatewayAgentId, adapterType: "hermes_gateway" }]);
  });

  it("7c. /model says so when only the whole gateway catalog could be read", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model",
        // No per-model providers and one id outside the known families: the
        // family falls back to the ids' own prefixes.
        readGatewayModelCatalog: async () => ({
          models: ["dashscope-qwen3-max", "model-x"],
          scope: "catalog",
        }),
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("whole gateway catalog");
    expect(text).toMatch(/1\) dashscope-qwen3-max/);
    expect(text).toMatch(/2\) model-x/);
    expect(text).toMatch(/model-x/);
  });

  it("7d. a failed profile apply rolls the override back to its previous value", async () => {
    const { issue, boardUserId } = await createTelegramConversation({
      agentId: gatewayAgentId,
      assigneeAdapterOverrides: { adapterConfig: { model: "model-a" } },
    });
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model nous-hermes-4",
        readGatewayModelCatalog: async () => ({ models: ["nous-hermes-4"], scope: "agentKey" }),
        botContainerApply: { apply: async () => ({ kind: "error", message: "profile write failed" }) },
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("could not be applied: profile write failed");
    expect(text).toContain("The previous value was restored.");
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "model-a" } });
  });

  it("7e. an apply with no runtime reports it and keeps the written override", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model nous-hermes-4",
        readGatewayModelCatalog: async () => ({ models: ["nous-hermes-4"], scope: "agentKey" }),
        // apply → null models "there is no runtime to apply to" (the
        // bot-containers wiring is off in this process, the production
        // default path too): not an error, and the value must stay.
        botContainerApply: { apply: async () => null },
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("is not running the new profile yet");
    expect(text).not.toContain("could not be applied");
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "nous-hermes-4" } });
  });

  it("8b. /think refuses an effort the chat's glm model does not accept, and accepts the allowed ones", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: glmAgentId });
    const applied: string[] = [];
    const applyDeps = {
      apply: async (agent: { agentId: string }) => {
        applied.push(agent.agentId);
        return { kind: "applied_files" as const };
      },
    };

    // zai's glm models take low/high/max only (effort-policy.ts): "medium" is
    // a known level, but not one this model accepts — refused, nothing written.
    const refused = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: glmAgentId,
        text: "/think medium",
        botContainerApply: applyDeps,
      }),
    );
    const refusedText = (refused as { kind: "reply"; text: string }).text;
    expect(refusedText).toContain("“medium” is not accepted by model glm-4.6");
    expect(refusedText).toContain("allowed: low, high, max");
    expect(await readOverrides(issue.id)).toBeNull();
    expect(applied).toEqual([]);

    const accepted = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: glmAgentId,
        text: "/think high",
        botContainerApply: applyDeps,
      }),
    );
    expect((accepted as { kind: "reply"; text: string }).text).toContain("Reasoning effort for this chat: high.");
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { effort: "high" } });
    expect(applied).toEqual([glmAgentId]);

    // A non-glm model keeps the full level list: "medium" is fine there.
    const plain = await createTelegramConversation();
    const plainResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: plain.issue.id, boardUserId: plain.boardUserId, text: "/think medium" }),
    );
    expect((plainResult as { kind: "reply"; text: string }).text).toContain("Reasoning effort for this chat: medium.");
  });

  it("7f. without an injected apply the production default finds no runtime and reports it", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: issue.id,
        boardUserId,
        agentId: gatewayAgentId,
        text: "/model nous-hermes-4",
        readGatewayModelCatalog: async () => ({ models: ["nous-hermes-4"], scope: "agentKey" }),
      }),
    );
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("is not running the new profile yet");
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "nous-hermes-4" } });
  });

  it("7g. an unsupported adapter's refusal names the adapter and the reason, in the chat's locale", async () => {
    const enConv = await createTelegramConversation({ agentId: otherGatewayAgentId });
    const en = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: enConv.issue.id,
        boardUserId: enConv.boardUserId,
        agentId: otherGatewayAgentId,
        text: "/model",
      }),
    );
    expect((en as { kind: "reply"; text: string }).text).toBe(
      "Changing the model is unavailable for adapter openclaw_gateway: this adapter does not support changing it from the chat",
    );

    const ruUser = randomUUID();
    await db.insert(userUiLanguage).values({ userId: ruUser, language: "ru" });
    const ruConv = await createTelegramConversation({ agentId: otherGatewayAgentId, boardUserId: ruUser });
    const ru = await runBridgedDirectMessageCommand(
      baseInput({
        conversationIssueId: ruConv.issue.id,
        boardUserId: ruUser,
        agentId: otherGatewayAgentId,
        text: "/think",
      }),
    );
    expect((ru as { kind: "reply"; text: string }).text).toBe(
      "Смена глубины рассуждений недоступна для адаптера openclaw_gateway: этот адаптер не поддерживает смену из чата",
    );
  });

  it("8. /think sets a known effort level and rejects an unknown one", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const high = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/think high" }),
    );
    expect(high).toEqual({
      kind: "reply",
      command: "think",
      outcome: "applied",
      text: "Reasoning effort for this chat: high. The next reply starts a new model session with this chat's recent history.",
    });
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { effort: "high" } });

    const bogus = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/think bogus" }),
    );
    expect(bogus).toMatchObject({
      kind: "reply",
      command: "think",
      text: expect.stringContaining('Unknown reasoning effort “bogus”.'),
    });
  });

  it("9. /new <model> sets the model and starts a new session; /reset resets without one", async () => {
    const withModel = await createTelegramConversation();
    const withModelResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: withModel.issue.id, boardUserId: withModel.boardUserId, text: "/new model-b" }),
    );
    expect(withModelResult).toEqual({
      kind: "message",
      body: "/new",
      notice: "New session started with model model-b. The history stays on the board.",
    });
    expect(await readOverrides(withModel.issue.id)).toEqual({ adapterConfig: { model: "model-b" } });

    const reset = await createTelegramConversation();
    const resetResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: reset.issue.id, boardUserId: reset.boardUserId, text: "/reset" }),
    );
    expect(resetResult).toEqual({
      kind: "message",
      body: "/new",
      notice: "New session started. The history stays on the board.",
    });
  });

  it("10. /stop cancels only this conversation's own queued and running runs", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const other = await createTelegramConversation();

    const [queued] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "queued", contextSnapshot: { issueId: issue.id } })
      .returning();
    const [running] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: { issueId: issue.id } })
      .returning();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: other.issue.id },
    });

    const cancelled: Array<{
      runId: string;
      reason: string;
      options: { errorCode?: string; resultJson?: Record<string, unknown> };
    }> = [];
    const cancelRun: BridgedCommandInput["cancelRun"] = async (runId, reason, options) => {
      cancelled.push({ runId, reason, options });
      return {};
    };
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/stop", cancelRun }),
    );
    expect(result).toEqual({ kind: "reply", command: "stop", text: "Stopping the current reply." });
    expect(cancelled.map((c) => c.runId).sort()).toEqual([queued!.id, running!.id].sort());
    for (const call of cancelled) {
      expect(call.options).toMatchObject({
        errorCode: "chat_session_stopped",
        resultJson: { cancelledByActorType: "user", cancelledByUserId: boardUserId },
      });
    }

    const idle = await createTelegramConversation();
    const idleResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: idle.issue.id, boardUserId: idle.boardUserId, text: "/stop" }),
    );
    expect(idleResult).toEqual({ kind: "reply", command: "stop", text: "Nothing is running right now." });
  });

  it("11. /status reports model source and session state without leaking any id", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/status" }),
    );
    expect(result?.kind).toBe("reply");
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("Model: model-a (agent default)");
    expect(text).toContain("Session: #1, model session will start fresh with the next reply");
    expect(text).toContain("Now: idle");
    expect(text).not.toMatch(UUID_PATTERN);
  });

  it("12. /help lists every command; /foo is unknown; /home/x is not a command", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const help = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/help" }),
    );
    expect(help?.kind).toBe("reply");
    const helpText = (help as { kind: "reply"; text: string }).text;
    for (const command of TELEGRAM_DM_COMMANDS) {
      expect(helpText).toContain(`/${command.command}`);
    }

    const unknown = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/foo" }),
    );
    expect(unknown).toEqual({
      kind: "reply",
      // myrmidon(X8c): `command` is a fixed literal here, not the chat's
      // own text — see the "12b" case below for why.
      command: "unknown",
      text: "Unknown command /foo. The command list is in /help.",
    });

    expect(parseBridgedCommand("/home/x")).toBeNull();
    const notACommand = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/home/x" }),
    );
    expect(notACommand).toBeNull();
  });

  it("12b. an unknown command's name never reaches the `command` result field, and is capped in reply text", async () => {
    const { issue, boardUserId } = await createTelegramConversation();

    // COMMAND_PATTERN allows digits and underscores in a command name, but
    // the X8 contract requires `command` to match [a-z-]+ (it feeds a
    // publication key); a fixed literal is used instead of echoing chat text.
    const withDigits = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/aaa_123" }),
    );
    expect(withDigits).toEqual({
      kind: "reply",
      command: "unknown",
      text: "Unknown command /aaa_123. The command list is in /help.",
    });

    // COMMAND_PATTERN also does not bound the command name's length; the
    // reply must still stay well short of a single Telegram message.
    const longName = "a".repeat(500);
    const longResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: `/${longName}` }),
    );
    expect(longResult?.kind).toBe("reply");
    expect((longResult as { command: string }).command).toBe("unknown");
    const longText = (longResult as { kind: "reply"; text: string }).text;
    expect(longText.length).toBeLessThan(150);
    expect(longText).toContain("…");
  });

  it("12c. (1.7-TG-LOCALE) an RU user's commands answer in Russian, an EN user's in English", async () => {
    const ruUser = randomUUID();
    const enUser = randomUUID();
    await db.insert(userUiLanguage).values([
      { userId: ruUser, language: "ru" },
      { userId: enUser, language: "en" },
    ]);
    const ruConv = await createTelegramConversation({ boardUserId: ruUser });
    const ruReply = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: ruConv.issue.id, boardUserId: ruUser, text: "/foo" }),
    );
    expect(ruReply).toEqual({
      kind: "reply",
      command: "unknown",
      text: "Неизвестная команда /foo. Список команд — /help.",
    });

    const enConv = await createTelegramConversation({ boardUserId: enUser });
    const enReply = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: enConv.issue.id, boardUserId: enUser, text: "/foo" }),
    );
    expect(enReply).toEqual({
      kind: "reply",
      command: "unknown",
      text: "Unknown command /foo. The command list is in /help.",
    });

    // /model for the RU user keeps identifiers and renders labels in RU.
    const ruModel = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: ruConv.issue.id, boardUserId: ruUser, text: "/model" }),
    );
    const ruModelText = (ruModel as { kind: "reply"; text: string }).text;
    expect(ruModelText).toContain("Модель: model-a (по умолчанию у агента)");
    expect(ruModelText).toContain("model-b");

    // The preference is read per message: switching it takes effect on the
    // very next reply without a restart.
    await db
      .update(userUiLanguage)
      .set({ language: "en" })
      .where(eq(userUiLanguage.userId, ruUser));
    const switched = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: ruConv.issue.id, boardUserId: ruUser, text: "/foo" }),
    );
    expect((switched as { text: string }).text).toBe(
      "Unknown command /foo. The command list is in /help.",
    );
  });

  it("13. commands refuse a web conversation and another person's Telegram conversation, writing nothing", async () => {
    const web = await createWebConversation();
    const webResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: web.issue.id, boardUserId: web.boardUserId, text: "/model" }),
    );
    // myrmidon(X8c): `command` is a fixed literal ("not-available"), not the
    // command that was typed — see the "13b" case below for why.
    expect(webResult).toEqual({ kind: "reply", command: "not-available", text: "This chat is not available." });

    const { issue, boardUserId } = await createTelegramConversation();
    const impersonating = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId: randomUUID(), text: "/model model-b" }),
    );
    expect(impersonating).toEqual({ kind: "reply", command: "not-available", text: "This chat is not available." });
    expect(await readOverrides(issue.id)).toBeNull();

    const activityForIssue = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issue.id)));
    expect(activityForIssue).toHaveLength(0);
  });

  it("13b. an unavailable chat's `command` result field ignores the (possibly malformed) command text", async () => {
    const web = await createWebConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: web.issue.id, boardUserId: web.boardUserId, text: "/aaa_123 with args" }),
    );
    expect(result).toEqual({ kind: "reply", command: "not-available", text: "This chat is not available." });
  });
});
