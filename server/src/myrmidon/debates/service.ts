// server/src/myrmidon/debates/service.ts
//
// myrmidon(1.7-DEBATE-ASYM-A): the debate service for a task.
//
// The board (or an agent through the autonomy matrix) asks for a debate about
// an issue's question. The service resolves the effective role configuration
// (cross-family rule included), runs the pure engine against the gateway,
// records the spent cost as cost events so the BUDGET-CONFIG accounting sees
// the debate at the task level, and writes the result as an issue document:
// positions, the judge's verdict, the cost. No restart is needed for a
// settings change — the configuration is read at run time.
//
// Everything the service touches (issue lookup, document write, cost
// accounting, model calls, settings read) comes in through deps, so the whole
// flow runs verbatim in tests with fake models and fake storage.

import {
  DEBATE_COMPLETED_ACTION,
  DEBATE_RESULT_DOCUMENT_KEY,
  renderDebateResultDocument,
  resolveDebateSettings,
  runDebate,
  type DebateModelCall,
  type DebateOutcome,
  type DebateSettings,
  type DebateSettingsResolution,
} from "@paperclipai/shared";

export interface DebateTaskRef {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
}

export interface DebateRunInput {
  companyId: string;
  issueId: string;
  /** The question to debate; defaults to the task title. */
  question?: string;
}

export interface DebateRunResult {
  issueId: string;
  documentKey: string;
  outcome: DebateOutcome;
  /** Cost events written; true when the accounting port recorded the spend. */
  costRecorded: boolean;
}

export interface DebateSettingsView {
  settings: DebateSettings | null;
  source: DebateSettingsResolution["source"];
  problem: string | null;
}

export interface DebateServiceDeps {
  /** The issue row or null; company scoping is the caller's check, re-checked here. */
  loadIssue(issueId: string): Promise<DebateTaskRef | null>;
  /** The effective config: stored row, then env override, then the default. */
  readSettings(): Promise<DebateSettingsResolution>;
  /** Persist and audit a saved configuration (PATCH); null clears the row. */
  writeSettings(settings: DebateSettings | null): Promise<DebateSettingsResolution>;
  /** The model call port — the gateway in production, fakes in tests. */
  callModel(companyId: string): Promise<DebateModelCall>;
  /** Write the result document onto the task. */
  writeDocument(input: { issueId: string; key: string; title: string; body: string; actorAgentId: string | null; actorUserId: string | null; runId: string | null }): Promise<void>;
  /** Record the debate spend against the task and the agent (budget accounting). */
  recordCost(input: {
    companyId: string;
    issueId: string;
    agentId: string | null;
    role: "generator" | "critic" | "judge";
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }): Promise<void>;
  /** Activity-log port for the run itself. */
  logActivity(input: { companyId: string; action: string; entityId: string; details: Record<string, unknown>; actorAgentId: string | null; actorUserId: string | null }): Promise<void>;
  now(): Date;
}

export interface DebateActor {
  agentId: string | null;
  userId: string | null;
  runId: string | null;
}

export class DebateConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DebateConfigError";
    this.code = code;
  }
}

export interface DebateService {
  /** The effective configuration view (GET /settings). */
  settingsView(): Promise<DebateSettingsView>;
  /** Validate + persist a configuration (PATCH /settings); a symmetric config is refused here too. */
  saveSettings(raw: unknown): Promise<DebateSettingsView>;
  /** Run one debate for a task and leave the result document on it. */
  run(input: DebateRunInput, actor: DebateActor): Promise<DebateRunResult>;
}

export function debateService(deps: DebateServiceDeps): DebateService {
  async function settingsView(): Promise<DebateSettingsView> {
    const resolution = await deps.readSettings();
    if (resolution.settings) {
      return { settings: resolution.settings, source: resolution.source, problem: null };
    }
    return { settings: null, source: resolution.source, problem: resolution.problem ?? "no debate configuration is available" };
  }

  async function saveSettings(raw: unknown): Promise<DebateSettingsView> {
    // Validate before persisting: the same rule the engine applies at run
    // time, so the settings page refuses a symmetric configuration with the
    // exact reason instead of storing a config that cannot run.
    if (raw === null || raw === undefined) {
      await deps.writeSettings(null);
      // A clear falls through to the environment/default level — report the
      // configuration that now applies, not "nothing".
      return settingsView();
    }
    const parsed = debateSettingsCandidate(raw);
    if (!parsed.ok) {
      throw new DebateConfigError("debate_config_invalid", parsed.problem);
    }
    const resolution = await deps.writeSettings(parsed.settings);
    return viewFromResolution(resolution);
  }

  function viewFromResolution(resolution: DebateSettingsResolution): DebateSettingsView {
    if (resolution.settings) {
      return { settings: resolution.settings, source: resolution.source, problem: null };
    }
    return {
      settings: null,
      source: resolution.source,
      problem: resolution.problem ?? "the debate configuration could not be resolved",
    };
  }

  return { settingsView, saveSettings, run };

  async function run(input: DebateRunInput, actor: DebateActor): Promise<DebateRunResult> {
    const issue = await deps.loadIssue(input.issueId);
    if (!issue || issue.companyId !== input.companyId) {
      throw new DebateConfigError("debate_issue_not_found", `issue ${input.issueId} does not exist in this company`);
    }
    const resolution = await deps.readSettings();
    if (!resolution.settings) {
      throw new DebateConfigError(
        "debate_config_rejected",
        resolution.problem ?? "no debate configuration is available on this instance",
      );
    }
    // The engine re-checks the family rule and reports it as the stop reason;
    // the service turns a refused configuration into the same error the route
    // maps to 422 — nothing was called and nothing is written for a refused
    // debate, the operator fixes the configuration instead.
    const question = (input.question?.trim() || issue.title).slice(0, 2000);
    const call = await deps.callModel(input.companyId);
    const outcome = await runDebate({
      question,
      settings: resolution.settings,
      call,
    });
    if (outcome.familyProblem) {
      throw new DebateConfigError("debate_config_rejected", outcome.familyProblem);
    }

    const documentBody = renderDebateResultDocument(outcome);
    await deps.writeDocument({
      issueId: issue.id,
      key: DEBATE_RESULT_DOCUMENT_KEY,
      title: `Debate result — ${issue.identifier ?? issue.title}`,
      body: documentBody,
      actorAgentId: actor.agentId,
      actorUserId: actor.userId,
      runId: actor.runId,
    });

    // Cost accounting at the task level (BUDGET-CONFIG reads cost_events with
    // an issue id): one event per role. cost_events requires an agent, so a
    // board-initiated debate without an agent identity is carried by the
    // activity log only; priced models are what make the rows meaningful.
    let costRecorded = false;
    if (actor.agentId && (outcome.cost.totalCents > 0 || outcome.tokensUsed > 0)) {
      const byRole = new Map<string, { model: string; input: number; output: number; cents: number }>();
      for (const turn of outcome.transcript) {
        if (outcome.tokensUsed > 0 && turn.inputTokens + turn.outputTokens === 0) continue;
        const row = byRole.get(turn.role) ?? { model: turn.model, input: 0, output: 0, cents: 0 };
        row.input += turn.inputTokens;
        row.output += turn.outputTokens;
        row.cents += turn.costCents;
        row.model = turn.model;
        byRole.set(turn.role, row);
      }
      for (const [role, row] of byRole) {
        await deps.recordCost({
          companyId: issue.companyId,
          issueId: issue.id,
          agentId: actor.agentId!,
          role: role as "generator" | "critic" | "judge",
          model: row.model,
          inputTokens: row.input,
          outputTokens: row.output,
          costCents: row.cents,
        });
      }
      costRecorded = byRole.size > 0;
    }

    await deps.logActivity({
      companyId: issue.companyId,
      action: DEBATE_COMPLETED_ACTION,
      entityId: issue.id,
      actorAgentId: actor.agentId,
      actorUserId: actor.userId,
      details: {
        question: question.slice(0, 200),
        roundsRun: outcome.roundsRun,
        roundsPlanned: outcome.roundsPlanned,
        stopReason: outcome.stopReason,
        tokensUsed: outcome.tokensUsed,
        tokenCeiling: outcome.tokenCeiling,
        totalCostCents: outcome.cost.totalCents,
        models: {
          generator: outcome.roles.generator.model,
          critic: outcome.roles.critic.model,
          judge: outcome.roles.judge.model,
        },
      },
    });

    return { issueId: issue.id, documentKey: DEBATE_RESULT_DOCUMENT_KEY, outcome, costRecorded };
  }
}

/** Parse + validate one PATCH candidate against the shared schema path. */
function debateSettingsCandidate(raw: unknown): { ok: true; settings: DebateSettings } | { ok: false; problem: string } {
  const resolution = resolveDebateSettings({ stored: raw });
  if (resolution.settings) return { ok: true, settings: resolution.settings };
  return { ok: false, problem: resolution.problem ?? "the debate configuration is not usable" };
}

export type { DebateOutcome };
