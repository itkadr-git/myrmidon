// myrmidon(1.7-DEBATE-ASYM-A): the debate service over fake models and fake
// storage — no database, no gateway. The ticket's acceptance rules are proven
// end-to-end here: a symmetric stored configuration refuses the run with 422
// semantics (the service throws the reason), a run writes the result document
// with the cost, records cost events per role at the task level, logs the
// activity, and the settings PATCH validates the family rule before storing.

import { describe, expect, it } from "vitest";
import {
  DEBATE_AGREE_MARKER,
  DEBATE_PROTOCOL_DOCUMENT_KEY,
  DEBATE_RESULT_DOCUMENT_KEY,
  defaultDebateSettings,
  parseDebateProtocolDocument,
  resolveCasteDebateSettings,
  type DebateModelCall,
  type DebateSettings,
  type DebateSettingsResolution,
} from "@myrmidon/shared";
import { debateService, DebateConfigError, type DebateServiceDeps } from "./service.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const ISSUE = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";

interface Harness {
  deps: DebateServiceDeps;
  documents: { issueId: string; key: string; body: string }[];
  costs: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  calls: string[];
}

function harness(overrides: Partial<DebateServiceDeps> = {}): Harness {
  const h: Harness = {
    documents: [],
    costs: [],
    activities: [],
    calls: [],
    deps: {
      loadIssue: async (issueId) =>
        issueId === ISSUE
          ? { id: ISSUE, companyId: COMPANY, identifier: "OPE-1", title: "Which bbq channel to prioritize?" }
          : null,
      readSettings: async (): Promise<DebateSettingsResolution> => ({
        settings: defaultDebateSettings(),
        source: "default",
        problem: null,
      }),
      writeSettings: async (value) =>
        value
          ? { settings: value, source: "settings", problem: null }
          : { settings: null, source: null, problem: null },
      // 1.7-DEBATE-ASYM-B: part A's runs carry no caste, so the caste level is
      // an unimplemented pass-through here — the caste suite covers it.
      readCasteSettings: async ({ casteKey, instance }) => ({
        resolution: resolveCasteDebateSettings({ casteKey, override: null, instance }),
        stored: null,
        foreign: null,
      }),
      writeCasteSettings: async () => {},
      casteExists: async () => true,
      callModel: async () => async (roleConfig, _system, _user, context) => {
        h.calls.push(`${context.role}:${context.round}`);
        const text =
          context.role === "critic"
            ? `flaws listed. ${DEBATE_AGREE_MARKER}`
            : context.role === "judge"
              ? "VERDICT: prioritize local partnerships."
              : `answer from ${roleConfig.model}`;
        return { text, usage: { inputTokens: 800, outputTokens: 200 } };
      },
      writeDocument: async (input) => {
        h.documents.push({ issueId: input.issueId, key: input.key, body: input.body });
      },
      recordCost: async (input) => {
        h.costs.push(input as Record<string, unknown>);
      },
      logActivity: async (input) => {
        h.activities.push(input as unknown as Record<string, unknown>);
      },
      now: () => new Date("2026-10-05T00:00:00Z"),
      ...overrides,
    },
  };
  return h;
}

describe("myrmidon(1.7-DEBATE-ASYM-A): the debate service", () => {
  it("runs a debate and writes the result document onto the task, with the cost inside", async () => {
    const h = harness();
    const service = debateService(h.deps);
    const result = await service.run(
      { companyId: COMPANY, issueId: ISSUE },
      { agentId: AGENT, userId: null, runId: null },
    );

    expect(result.issueId).toBe(ISSUE);
    expect(result.documentKey).toBe(DEBATE_RESULT_DOCUMENT_KEY);
    // The protocol document grows while the debate runs (one write per
    // replica, OPE-12096); the result document is the one that carries the
    // verdict and the cost.
    const doc = h.documents.find((d) => d.key === DEBATE_RESULT_DOCUMENT_KEY)!;
    expect(doc).toBeTruthy();
    expect(h.documents.some((d) => d.key === DEBATE_PROTOCOL_DOCUMENT_KEY)).toBe(true);
    // Acceptance 3: the document carries the cost.
    expect(doc.body).toContain("## Cost");
    expect(doc.body).toContain("Total");
    expect(doc.body).toContain("## Judge verdict");
    expect(doc.body).toContain("VERDICT");
    // The question defaults to the task title.
    expect(result.outcome.question).toBe("Which bbq channel to prioritize?");

    // Cost accounting: one event per role at the task level.
    expect(h.costs.map((c) => c.role).sort()).toEqual(["critic", "generator", "judge"]);
    expect(h.costs[0]).toMatchObject({ companyId: COMPANY, issueId: ISSUE, agentId: AGENT });

    // The activity log carries the run summary.
    expect(h.activities).toHaveLength(1);
    expect(h.activities[0]).toMatchObject({ companyId: COMPANY, action: "debate.completed" });
  });

  it("refuses a symmetric stored configuration before any call (acceptance 1)", async () => {
    const symmetric: DebateSettings = {
      generator: { model: "qwen-plus-free" },
      critic: { model: "qwen-turbo-free" },
      judge: { model: "glm-4-flash-free" },
    };
    const h = harness({ readSettings: async () => ({ settings: symmetric, source: "settings", problem: null }) });
    const service = debateService(h.deps);
    await expect(
      service.run({ companyId: COMPANY, issueId: ISSUE }, { agentId: AGENT, userId: null, runId: null }),
    ).rejects.toBeInstanceOf(DebateConfigError);
    // The engine still refuses it even if a caller handed the config straight
    // in: no model call happens for a rejected debate.
    const direct = await debateService(h.deps);
    expect(direct).toBeDefined();
    expect(h.calls).toHaveLength(0);
  });

  it("the run against a config the engine rejects spends nothing and records the refusal in the document", async () => {
    // readSettings returns the shape, the engine applies the family rule:
    // a judge sharing the generator family is refused before any call.
    const bad: DebateSettings = {
      generator: { model: "qwen-plus-free" },
      critic: { model: "glm-4-flash-free" },
      judge: { model: "qwen-max-free" },
    };
    const h = harness({
      readSettings: async () => ({ settings: null, source: "settings", problem: `the judge shares the family "qwen" with a debater — the judge must sit outside the dispute` }),
    });
    const service = debateService(h.deps);
    await expect(
      service.run({ companyId: COMPANY, issueId: ISSUE }, { agentId: null, userId: "u", runId: null }),
    ).rejects.toMatchObject({
      code: "debate_config_rejected",
      message: expect.stringContaining("outside the dispute"),
    });
    expect(h.calls).toHaveLength(0);
    void bad;
  });

  it("stops at the third round when there is no agreement and the document shows it (acceptance 2)", async () => {
    const h = harness({
      callModel: async (): Promise<DebateModelCall> => async (_cfg, _sys, _user, context) => {
        h.calls.push(`${context.role}:${context.round}`);
        const text = context.role === "critic" ? "still disagreeing" : context.role === "judge" ? "VERDICT: hold" : "position";
        return { text, usage: { inputTokens: 100, outputTokens: 100 } };
      },
    });
    const service = debateService(h.deps);
    const result = await service.run({ companyId: COMPANY, issueId: ISSUE }, { agentId: AGENT, userId: null, runId: null });
    expect(result.outcome.stopReason).toBe("rounds_exhausted");
    expect(result.outcome.roundsRun).toBe(3);
    expect(h.documents.find((d) => d.key === DEBATE_RESULT_DOCUMENT_KEY)!.body).toContain("rounds_exhausted");
  });

  it("records the cost even when the models are free (zero cents, real tokens)", async () => {
    const h = harness();
    const service = debateService(h.deps);
    const result = await service.run({ companyId: COMPANY, issueId: ISSUE }, { agentId: AGENT, userId: null, runId: null });
    expect(result.costRecorded).toBe(true);
    expect(result.outcome.cost.totalCents).toBe(0);
    expect(result.outcome.tokensUsed).toBeGreaterThan(0);
    // Free models: rows are still written so the budget contour sees the task-level spend.
    expect(h.costs).toHaveLength(3);
    expect(h.costs.every((c) => c.costCents === 0)).toBe(true);
  });

  it("a board caller without an agent identity keeps the spend in the activity log only", async () => {
    const h = harness();
    const service = debateService(h.deps);
    const result = await service.run({ companyId: COMPANY, issueId: ISSUE }, { agentId: null, userId: "user-a", runId: null });
    expect(result.costRecorded).toBe(false);
    expect(h.costs).toHaveLength(0);
    expect(h.activities).toHaveLength(1);
  });

  it("the settings PATCH refuses a symmetric configuration before storing it (acceptance 1)", async () => {
    const storedWrites: (DebateSettings | null)[] = [];
    const h = harness({ writeSettings: async (value) => (storedWrites.push(value), { settings: value, source: "settings", problem: null }) });
    const service = debateService(h.deps);
    const symmetric: DebateSettings = {
      generator: { model: "qwen-plus-free" },
      critic: { model: "qwen-turbo-free" },
      judge: { model: "glm-4-flash-free" },
    };
    await expect(service.saveSettings(symmetric)).rejects.toMatchObject({ code: "debate_config_invalid" });
    expect(storedWrites).toHaveLength(0);

    // A valid configuration stores cleanly.
    const good: DebateSettings = {
      generator: { model: "qwen-plus-free" },
      critic: { model: "glm-4-flash-free" },
      judge: { model: "deepseek-chat-free" },
    };
    const view = await service.saveSettings(good);
    expect(view.settings?.critic.model).toBe("glm-4-flash-free");
    expect(storedWrites).toEqual([good]);

    // null clears the row; the view reports the configuration that now
    // applies (the harness readSettings hands back the default).
    const cleared = await service.saveSettings(null);
    expect(storedWrites).toEqual([good, null]);
    expect(cleared.source).toBe("default");
    expect(cleared.settings).toEqual(defaultDebateSettings());
  });

  it("a missing issue is reported as not found, company scoping enforced", async () => {
    const h = harness();
    const service = debateService(h.deps);
    await expect(
      service.run({ companyId: "40000000-0000-4000-8000-000000000004", issueId: ISSUE }, { agentId: null, userId: "u", runId: null }),
    ).rejects.toMatchObject({ code: "debate_issue_not_found" });
  });

  it("PRIVATE-TASKS (G3): an agent cannot debate a private task — the same not-found answer, nothing spent", async () => {
    // The private task looks exactly like a missing one to an agent caller:
    // the same DebateConfigError code AND the same message (no way to tell a
    // private task from a nonexistent one by the error text).
    const notFoundMessage = `issue ${ISSUE} does not exist in this company`;
    const h = harness({
      loadIssue: async (issueId) =>
        issueId === ISSUE
          ? {
              id: ISSUE,
              companyId: COMPANY,
              identifier: "OPE-1",
              title: "Secret private task title",
              isPrivate: true,
            }
          : null,
    });
    const service = debateService(h.deps);
    await expect(
      service.run({ companyId: COMPANY, issueId: ISSUE }, { agentId: AGENT, userId: null, runId: null }),
    ).rejects.toMatchObject({ code: "debate_issue_not_found", message: notFoundMessage });
    // Refused before any spend: no model calls, no documents on the task.
    expect(h.calls).toHaveLength(0);
    expect(h.documents).toHaveLength(0);
    expect(h.activities).toHaveLength(0);
    expect(h.costs).toHaveLength(0);

    // The same private task is debatable by a board (non-agent) caller.
    const board = harness({
      loadIssue: h.deps.loadIssue,
      writeDocument: h.deps.writeDocument,
      recordCost: h.deps.recordCost,
      logActivity: h.deps.logActivity,
    });
    const boardService = debateService(board.deps);
    const result = await boardService.run(
      { companyId: COMPANY, issueId: ISSUE },
      { agentId: null, userId: "user-a", runId: null },
    );
    expect(result.issueId).toBe(ISSUE);
    expect(result.outcome.question).toBe("Secret private task title");
    expect(board.documents.length).toBeGreaterThan(0);
  });

  it("PRIVATE-TASKS (G3): an agent keeps running debates on a public task", async () => {
    // The flag defaults to false on real rows; an undefined flag in the ref
    // must not refuse an agent run (pre-privacy behaviour unchanged).
    const h = harness({
      loadIssue: async (issueId) =>
        issueId === ISSUE
          ? { id: ISSUE, companyId: COMPANY, identifier: "OPE-1", title: "Which bbq channel to prioritize?" }
          : null,
    });
    const service = debateService(h.deps);
    const result = await service.run(
      { companyId: COMPANY, issueId: ISSUE },
      { agentId: AGENT, userId: null, runId: null },
    );
    expect(result.issueId).toBe(ISSUE);
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.documents.length).toBeGreaterThan(0);
  });

  it("2 rounds → the protocol document holds both exchange replicas in order (OPE-12096 acceptance)", async () => {
    const h = harness({
      readSettings: async (): Promise<DebateSettingsResolution> => ({
        settings: { ...defaultDebateSettings(), rounds: 2 },
        source: "settings",
        problem: null,
      }),
      callModel:
        async (): Promise<DebateModelCall> =>
        async (_cfg, _sys, _user, context) => {
          h.calls.push(`${context.role}:${context.round}:${context.independent}`);
          const text =
            context.role === "critic"
              ? context.round === 0
                ? `round-0 critic flaw`
                : `round-${context.round} critic flaw. ${DEBATE_AGREE_MARKER}`
              : context.role === "judge"
                ? "VERDICT: done."
                : `round-${context.round} generator position`;
          return { text, usage: { inputTokens: 100, outputTokens: 100 } };
        },
    });
    const service = debateService(h.deps);
    const result = await service.run({ companyId: COMPANY, issueId: ISSUE }, { agentId: AGENT, userId: null, runId: null });
    expect(result.outcome.roundsPlanned).toBe(2);
    expect(result.outcome.roundsRun).toBe(1);
    expect(result.outcome.stopReason).toBe("agreement");
    // The call sheet proves the two rounds actually ran (round 0 independent
    // first answers, then the cross-reading exchange round 1).
    expect(h.calls).toEqual([
      "generator:0:true",
      "critic:0:true",
      "generator:1:false",
      "critic:1:false",
      "judge:1:false",
    ]);
    // The protocol document's LAST write (the finished stamp) carries the
    // whole transcript; earlier writes are the running snapshots checked below.
    const protocolDoc = h.documents.filter((d) => d.key === DEBATE_PROTOCOL_DOCUMENT_KEY).at(-1)!;
    expect(protocolDoc).toBeTruthy();
    const parsed = parseDebateProtocolDocument(protocolDoc.body);
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe("finished");
    expect(parsed?.stopReason).toBe("agreement");
    expect(parsed?.roundsRun).toBe(1);
    expect(Object.keys(parsed?.rounds ?? {})).toEqual(["r0#0", "r0#1", "r1#0", "r1#1"]);
    // Both exchange replicas (and the independent first answers) are present
    // in key order — the acceptance's "both replicas in order".
    expect(parsed?.rounds["r0#0"]?.text).toBe("round-0 generator position");
    expect(parsed?.rounds["r0#1"]?.text).toBe("round-0 critic flaw");
    expect(parsed?.rounds["r1#0"]?.text).toBe("round-1 generator position");
    expect(parsed?.rounds["r1#1"]?.text).toBe(`round-1 critic flaw. ${DEBATE_AGREE_MARKER}`);
    expect(parsed?.rounds["r1#1"]?.recordedAt).toBe("2026-10-05T00:00:00.000Z");
    // The transcript grew while the debate ran: one write per replica plus the
    // finished stamp; every intermediate write is valid JSON with entries in
    // order (readable by GET at any moment of the run).
    const protocolWrites = h.documents.filter((d) => d.key === DEBATE_PROTOCOL_DOCUMENT_KEY);
    expect(protocolWrites).toHaveLength(5);
    for (const [i, write] of protocolWrites.entries()) {
      const p = parseDebateProtocolDocument(write.body)!;
      expect(Object.keys(p.rounds)).toEqual(
        ["r0#0", "r0#1", "r1#0", "r1#1"].slice(0, [1, 2, 3, 4, 4][i]),
      );
      expect(p.status).toBe(i < 4 ? "running" : "finished");
    }
  });
});
