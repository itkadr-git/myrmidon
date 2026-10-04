// myrmidon(1.6.3 PROMPT-BUDGET C): prompt-budget advice tests.
//
// Two tiers in one file: the pure generator (rules fire on a bloated breakdown
// and stay silent on a healthy one) and the HTTP contract of the two routes
// driven with supertest against in-memory fakes — no database, no network.
//
// The fakes answer with the `lastRun` shape of the prompt-budget status
// contract of the same release (`{ runId, total, parts }`), which is exactly
// what the read port returns; the status route itself is mocked here while its
// part is unmerged.
//
// Neutral data only: agent-a ids, no internal names or hosts.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import {
  PROMPT_BUDGET_ADVICE_CRIT_SHARE_PCT,
  PROMPT_BUDGET_ADVICE_MIN_TOTAL_TOKENS,
  PROMPT_BUDGET_ADVICE_SHARE_PCT,
  adviceRuleFor,
  buildPromptBudgetAdvice,
} from "./advice.js";
import { deepAnalysisOriginId } from "./deep.js";
import { promptBudgetAdviceRoutes, type PromptBudgetAdviceDeps } from "./routes.js";
import { normalizeOptimizerAgentId, readOptimizerAgentIdFromGeneral } from "./settings.js";
import { parsePromptBreakdown, type PromptBudgetAgentRef } from "./source.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OPTIMIZER_ID = "33333333-3333-4333-8333-333333333333";
const FOREIGN_AGENT_ID = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-a",
};

const TARGET: PromptBudgetAgentRef = { agentId: AGENT_ID, name: "agent-a", model: "model-a" };
const OPTIMIZER: PromptBudgetAgentRef = {
  agentId: OPTIMIZER_ID,
  name: "agent-b",
  model: "model-b",
};

const BASE = `/api/myrmidon/companies/${COMPANY_ID}/prompt-budget/agents/${AGENT_ID}/advice`;

function makeDeps(overrides: Partial<PromptBudgetAdviceDeps> = {}): PromptBudgetAdviceDeps {
  return {
    source: {
      loadAgent: async (_companyId: string, agentId: string) => {
        if (agentId === AGENT_ID) return TARGET;
        if (agentId === OPTIMIZER_ID) return OPTIMIZER;
        return null;
      },
      loadLastRun: async () => ({
        runId: RUN_ID,
        total: 20_000,
        parts: { instructionsBundle: 6_000, sessionHistory: 9_000, wakePayload: 3_000 },
      }),
    },
    settings: {
      getGeneral: async () => ({ promptBudget: { optimizerAgentId: OPTIMIZER_ID } }),
    },
    createTask: vi.fn(async (_companyId: string, task) => ({
      id: "55555555-5555-4555-8555-555555555555",
      identifier: "OPA-1",
      title: task.title,
    })),
    ...overrides,
  };
}

function app(actor: unknown, deps: Partial<PromptBudgetAdviceDeps> = {}) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", promptBudgetAdviceRoutes({} as never, deps));
  server.use(errorHandler);
  return server;
}

describe("myrmidon(1.6.3 PROMPT-BUDGET C) advice rules", () => {
  it("names the bloated parts and their action on a dominated breakdown", () => {
    const advice = buildPromptBudgetAdvice({
      agentId: AGENT_ID,
      run: {
        runId: RUN_ID,
        total: 20_000,
        parts: { instructionsBundle: 6_000, sessionHistory: 9_000, wakePayload: 3_000 },
      },
    });

    expect(advice.hasRun).toBe(true);
    expect(advice.healthy).toBe(false);
    // sessionHistory 45% and instructionsBundle 30% cross the threshold;
    // wakePayload 15% does not.
    expect(advice.recommendations.map((item) => item.part)).toEqual([
      "sessionHistory",
      "instructionsBundle",
    ]);
    const session = advice.recommendations[0]!;
    expect(session.ruleId).toBe("session-history");
    expect(session.sharePct).toBe(45);
    expect(session.severity).toBe("warn");
    expect(session.action.toLowerCase()).toContain("session");
    const instructions = advice.recommendations[1]!;
    expect(instructions.ruleId).toBe("instructions");
    expect(instructions.action.toLowerCase()).toContain("skills");
    // The full breakdown is reported biggest first, threshold aside.
    expect(advice.parts.map((part) => part.part)).toEqual([
      "sessionHistory",
      "instructionsBundle",
      "wakePayload",
    ]);
  });

  it("marks a part at or above the critical share as critical", () => {
    const advice = buildPromptBudgetAdvice({
      agentId: AGENT_ID,
      run: { runId: RUN_ID, total: 10_000, parts: { toolResults: 6_000, wakePrompt: 4_000 } },
    });
    expect(PROMPT_BUDGET_ADVICE_CRIT_SHARE_PCT).toBe(50);
    expect(advice.recommendations.find((item) => item.part === "toolResults")?.severity).toBe("crit");
    expect(advice.recommendations.find((item) => item.part === "wakePrompt")?.severity).toBe("warn");
  });

  it("stays silent on a healthy breakdown", () => {
    const advice = buildPromptBudgetAdvice({
      agentId: AGENT_ID,
      run: {
        runId: RUN_ID,
        total: 10_000,
        parts: { a1: 2_500, a2: 2_500, a3: 2_500, a4: 2_500 },
      },
    });
    expect(PROMPT_BUDGET_ADVICE_SHARE_PCT).toBe(30);
    expect(advice.healthy).toBe(true);
    expect(advice.recommendations).toEqual([]);
    expect(advice.parts).toHaveLength(4);
  });

  it("stays silent on a prompt smaller than the advice floor", () => {
    const advice = buildPromptBudgetAdvice({
      agentId: AGENT_ID,
      run: { runId: RUN_ID, total: PROMPT_BUDGET_ADVICE_MIN_TOTAL_TOKENS - 1, parts: { only: 1_999 } },
    });
    expect(advice.healthy).toBe(true);
    expect(advice.recommendations).toEqual([]);
  });

  it("reports a runless agent instead of calling it healthy", () => {
    const advice = buildPromptBudgetAdvice({ agentId: AGENT_ID, run: null });
    expect(advice.hasRun).toBe(false);
    expect(advice.runId).toBeNull();
    expect(advice.total).toBe(0);
    expect(advice.healthy).toBe(true);
  });

  it("falls through to the generic rule for an unknown part key", () => {
    const advice = buildPromptBudgetAdvice({
      agentId: AGENT_ID,
      run: { runId: RUN_ID, total: 10_000, parts: { "mystery-block": 8_000 } },
    });
    expect(advice.recommendations).toHaveLength(1);
    expect(advice.recommendations[0]!.ruleId).toBe("generic");
    expect(adviceRuleFor("mystery-block").id).toBe("generic");
  });

  it("ignores malformed parts and keeps the total", () => {
    const advice = buildPromptBudgetAdvice({
      agentId: AGENT_ID,
      run: {
        runId: RUN_ID,
        total: 8_000,
        parts: { instructions: 8_000, broken: 0, negative: -5, nothing: Number.NaN },
      },
    });
    expect(advice.parts.map((part) => part.part)).toEqual(["instructions"]);
    expect(advice.parts[0]!.sharePct).toBe(100);
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET C) stored breakdown", () => {
  it("reads the recorded per-part breakdown", () => {
    expect(
      parsePromptBreakdown({
        promptBreakdown: { parts: { instructions: 12, wakePrompt: 4.6 }, total: 20 },
      }),
    ).toEqual({ total: 20, parts: { instructions: 12, wakePrompt: 5 } });
  });

  it("falls back to the input-token total without parts", () => {
    expect(parsePromptBreakdown({ inputTokens: 1_234 })).toEqual({
      total: 1_234,
      parts: {},
    });
  });

  it("reads nothing from a run without usage", () => {
    expect(parsePromptBreakdown(null)).toBeNull();
    expect(parsePromptBreakdown({})).toBeNull();
    expect(parsePromptBreakdown({ promptBreakdown: { parts: {} } })).toBeNull();
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET C) optimizer setting", () => {
  it("accepts only a uuid and normalises its case", () => {
    expect(normalizeOptimizerAgentId(OPTIMIZER_ID.toUpperCase())).toBe(OPTIMIZER_ID);
    expect(normalizeOptimizerAgentId("not-an-agent")).toBeNull();
    expect(normalizeOptimizerAgentId("")).toBeNull();
    expect(normalizeOptimizerAgentId(42)).toBeNull();
  });

  it("reads the field out of the prompt-budget area only", () => {
    expect(readOptimizerAgentIdFromGeneral({ promptBudget: { optimizerAgentId: OPTIMIZER_ID } })).toBe(
      OPTIMIZER_ID,
    );
    expect(readOptimizerAgentIdFromGeneral({ optimizerAgentId: OPTIMIZER_ID })).toBeNull();
    expect(readOptimizerAgentIdFromGeneral({ promptBudget: { warnPct: 70 } })).toBeNull();
    expect(readOptimizerAgentIdFromGeneral(null)).toBeNull();
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET C) advice routes", () => {
  it("answers the company member with the recommendations of the last run", async () => {
    const response = await request(app(member, makeDeps())).get(BASE).expect(200);
    expect(response.body.agentId).toBe(AGENT_ID);
    expect(response.body.agentName).toBe("agent-a");
    expect(response.body.healthy).toBe(false);
    expect(response.body.recommendations[0]).toMatchObject({
      part: "sessionHistory",
      severity: "warn",
    });
    expect(response.body.recommendations[0].action.length).toBeGreaterThan(0);
  });

  it("404s an agent that is not one of the company's agents", async () => {
    await request(app(member, makeDeps()))
      .get(`${BASE.replace(AGENT_ID, FOREIGN_AGENT_ID)}`)
      .expect(404);
  });

  it("files the deep task for the configured optimizer agent", async () => {
    const deps = makeDeps();
    const response = await request(app(member, deps)).post(`${BASE}/deep`).expect(201);

    expect(response.body).toEqual({
      issueId: "55555555-5555-4555-8555-555555555555",
      identifier: "OPA-1",
      title: "Prompt budget deep analysis: agent-a",
    });

    expect(deps.createTask).toHaveBeenCalledTimes(1);
    const [companyId, task] = (deps.createTask as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(companyId).toBe(COMPANY_ID);
    expect(task.assigneeAgentId).toBe(OPTIMIZER_ID);
    expect(task.status).toBe("todo");
    expect(task.originId).toBe(deepAnalysisOriginId(AGENT_ID, RUN_ID));
    expect(task.idempotencyKey).toBe(task.originId);
    // The description carries the target agent, the breakdown and the draft ask.
    expect(task.description).toContain(AGENT_ID);
    expect(task.description).toContain("agent-a");
    expect(task.description).toContain(RUN_ID);
    expect(task.description).toContain("20000");
    expect(task.description).toContain("sessionHistory");
    expect(task.description).toContain("9000");
    expect(task.description.toLowerCase()).toContain("draft");
    expect(task.description.toLowerCase()).toContain("comment on this task");
    // …and the safety rail: the deep pass must not mutate the target.
    expect(task.description).toContain("Do not change any agent configuration");
  });

  it("422s a deep request with a clear text when no optimizer agent is configured", async () => {
    const deps = makeDeps({ settings: { getGeneral: async () => ({ promptBudget: { warnPct: 70 } }) } });
    const response = await request(app(member, deps)).post(`${BASE}/deep`).expect(422);
    expect(response.body.error).toContain("promptBudget.optimizerAgentId");
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("422s when the configured optimizer agent is not in the company", async () => {
    const deps = makeDeps({
      settings: { getGeneral: async () => ({ promptBudget: { optimizerAgentId: FOREIGN_AGENT_ID } }) },
    });
    const response = await request(app(member, deps)).post(`${BASE}/deep`).expect(422);
    expect(response.body.error).toContain("not an agent of this company");
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("422s when the agent has no recorded run", async () => {
    const deps = makeDeps({
      source: {
        loadAgent: async (_companyId: string, agentId: string) =>
          agentId === AGENT_ID ? TARGET : OPTIMIZER,
        loadLastRun: async () => null,
      },
    });
    const response = await request(app(member, deps)).post(`${BASE}/deep`).expect(422);
    expect(response.body.error).toContain("no recorded run");
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("refuses an agent actor on the deep route (board-only)", async () => {
    const deps = makeDeps();
    await request(app(agentActor, deps)).post(`${BASE}/deep`).expect(403);
    expect(deps.createTask).not.toHaveBeenCalled();
  });
});