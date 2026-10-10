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
  DEBATE_CASTES_KEY,
  DEBATE_CASTE_SETTINGS_ACTION,
  DEBATE_COMPLETED_ACTION,
  DEBATE_RESULT_DOCUMENT_KEY,
  casteDebateGate,
  casteDebatePatchSchema,
  customPromptRoles,
  parseCasteDebateKey,
  renderCasteDebateSummary,
  renderDebateResultDocument,
  resolveCasteDebateSettings,
  resolveDebateSettings,
  runDebate,
  type CasteDebateOverride,
  type CasteDebatePatch,
  type CasteDebateResolution,
  type DebateModelCall,
  type DebateOutcome,
  type DebatePromptOverrides,
  type DebateSettings,
  type DebateSettingsResolution,
} from "@paperclipai/shared";

export interface DebateTaskRef {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  /**
   * The caste of the task (1.7-DEBATE-ASYM-B): the role of the assignee agent,
   * or null when the task is not routed to an agent yet.
   */
  casteKey?: string | null;
}

export interface DebateRunInput {
  companyId: string;
  issueId: string;
  /** The question to debate; defaults to the task title. */
  question?: string;
  /**
   * The caste the debate runs for. The board button sends the caste of the row
   * it sits on; without it the task's own caste (the assignee's role) is used,
   * and a task with neither keeps part A's instance-level behaviour.
   */
  casteKey?: string;
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

/**
 * One caste's view for the settings screen (1.7-DEBATE-ASYM-B): the effective
 * values, where each part came from, and the stored entry for the editor.
 */
export interface CasteDebateSettingsView {
  casteKey: string;
  /** Whether a debate may run for this caste right now. */
  enabled: boolean;
  /** "caste" — the switch was set for this caste; "default" — it was not. */
  enabledSource: CasteDebateResolution["enabledSource"];
  /** The configuration a run would use (null when a problem is reported). */
  settings: DebateSettings | null;
  /** "caste" when the caste overrides the roles/rounds/ceiling, else the instance source. */
  source: CasteDebateResolution["source"];
  /** The instance level this caste inherits from. */
  instanceSource: DebateSettingsResolution["source"];
  /** The knobs the caste entry overrides. */
  overrides: string[];
  /** Custom role guidance in effect. */
  prompts: DebatePromptOverrides;
  /** Why the configuration cannot run, if it cannot. */
  problem: string | null;
  /** The stored entry, for the editor form; null = the caste inherits. */
  stored: CasteDebatePatch | null;
  /** One line for the caption: values, sources, overrides. */
  summary: string;
}

export interface DebateServiceDeps {
  /** The issue row or null; company scoping is the caller's check, re-checked here. */
  loadIssue(issueId: string): Promise<DebateTaskRef | null>;
  /** The effective config: stored row, then env override, then the default. */
  readSettings(): Promise<DebateSettingsResolution>;
  /** Persist and audit a saved configuration (PATCH); null clears the row. */
  writeSettings(settings: DebateSettings | null): Promise<DebateSettingsResolution>;
  /**
   * One caste's resolution: its stored entry over the instance configuration
   * (1.7-DEBATE-ASYM-B). `stored` is the raw entry, for the editor.
   */
  readCasteSettings(input: {
    companyId: string;
    casteKey: string;
    instance: DebateSettingsResolution;
  }): Promise<{ resolution: CasteDebateResolution; stored: CasteDebateOverride | null; foreign: string | null }>;
  /** Persist a caste entry (PATCH) or clear it with null. */
  writeCasteSettings(input: { companyId: string; casteKey: string; patch: CasteDebatePatch | null }): Promise<void>;
  /** Whether the caste key is in the company's directory (the API's 404 gate). */
  casteExists(input: { companyId: string; casteKey: string }): Promise<boolean>;
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
  /** One caste's configuration view (1.7-DEBATE-ASYM-B); unknown caste → not found. */
  casteSettingsView(input: { companyId: string; casteKey: string }): Promise<CasteDebateSettingsView>;
  /** Validate + persist a caste entry (PATCH); null clears it back to inheriting. */
  saveCasteSettings(
    input: { companyId: string; casteKey: string; raw: unknown },
    actor?: DebateActor,
  ): Promise<CasteDebateSettingsView>;
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

  async function casteSettingsView(input: { companyId: string; casteKey: string }): Promise<CasteDebateSettingsView> {
    const casteKey = requireCasteKey(input.casteKey);
    await requireCaste(input.companyId, casteKey);
    const instance = await deps.readSettings();
    const read = await deps.readCasteSettings({ companyId: input.companyId, casteKey, instance });
    return viewFromCaste(read.resolution, read.stored);
  }

  async function saveCasteSettings(
    input: { companyId: string; casteKey: string; raw: unknown },
    actor?: DebateActor,
  ): Promise<CasteDebateSettingsView> {
    const casteKey = requireCasteKey(input.casteKey);
    await requireCaste(input.companyId, casteKey);
    const cleared = input.raw === null || input.raw === undefined;
    if (cleared) {
      // A clear: the caste goes back to inheriting the instance configuration.
      await deps.writeCasteSettings({ companyId: input.companyId, casteKey, patch: null });
      const view = await casteSettingsView({ companyId: input.companyId, casteKey });
      await auditCasteSave({ companyId: input.companyId, view, cleared: true, actor });
      return view;
    }
    const parsed = casteDebatePatchSchema.safeParse(input.raw);
    if (!parsed.success) {
      throw new DebateConfigError(
        "debate_config_invalid",
        `the caste debate entry is malformed: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    // The asymmetry rule is enforced on the MERGED configuration, not on the
    // patch: a caste that overrides only the critic must not slip a
    // same-family judge past the rule the owner set. Nothing is stored when
    // the result cannot run.
    const instance = await deps.readSettings();
    const preview = resolveCasteDebateSettings({
      casteKey,
      override: { companyId: input.companyId, ...parsed.data },
      instance,
    });
    if (preview.problem || !preview.settings) {
      throw new DebateConfigError(
        "debate_config_rejected",
        preview.problem ?? `caste "${casteKey}" has no usable debate configuration`,
      );
    }
    await deps.writeCasteSettings({ companyId: input.companyId, casteKey, patch: parsed.data });
    const view = await casteSettingsView({ companyId: input.companyId, casteKey });
    await auditCasteSave({ companyId: input.companyId, view, cleared: false, actor });
    return view;
  }

  /** Every caste settings write leaves a line, so a switch change is traceable. */
  async function auditCasteSave(
    input: { companyId: string; view: CasteDebateSettingsView; cleared: boolean; actor?: DebateActor },
  ): Promise<void> {
    const { view } = input;
    await deps.logActivity({
      companyId: input.companyId,
      action: DEBATE_CASTE_SETTINGS_ACTION,
      entityId: view.casteKey,
      details: {
        casteKey: view.casteKey,
        cleared: input.cleared,
        overrides: view.overrides,
        enabled: view.enabled,
        enabledSource: view.enabledSource,
        source: view.source,
        instanceSource: view.instanceSource,
        customPrompts: Object.keys(view.prompts),
      },
      actorAgentId: input.actor?.agentId ?? null,
      actorUserId: input.actor?.userId ?? null,
    });
  }

  function viewFromCaste(resolution: CasteDebateResolution, stored: CasteDebateOverride | null): CasteDebateSettingsView {
    const { companyId: _companyId, ...patch } = stored ?? { companyId: "" };
    return {
      casteKey: resolution.casteKey,
      enabled: resolution.enabled,
      enabledSource: resolution.enabledSource,
      settings: resolution.settings,
      source: resolution.source,
      instanceSource: resolution.instanceSource,
      overrides: resolution.overrides,
      prompts: resolution.prompts,
      problem: resolution.problem,
      stored: stored ? patch : null,
      summary: renderCasteDebateSummary(resolution),
    };
  }

  /** A caste must exist in the company's directory before anything is resolved. */
  async function requireCaste(companyId: string, casteKey: string): Promise<void> {
    if (!(await deps.casteExists({ companyId, casteKey }))) {
      throw new DebateConfigError("debate_caste_not_found", `caste "${casteKey}" is not in this company's directory`);
    }
  }

  function requireCasteKey(raw: string): string {
    const parsed = parseCasteDebateKey(raw);
    if (!parsed.ok) {
      throw new DebateConfigError("debate_config_invalid", parsed.problem);
    }
    return parsed.key;
  }

  return { settingsView, saveSettings, casteSettingsView, saveCasteSettings, run };

  async function run(input: DebateRunInput, actor: DebateActor): Promise<DebateRunResult> {
    const issue = await deps.loadIssue(input.issueId);
    if (!issue || issue.companyId !== input.companyId) {
      throw new DebateConfigError("debate_issue_not_found", `issue ${input.issueId} does not exist in this company`);
    }
    const resolution = await deps.readSettings();

    // Caste level (1.7-DEBATE-ASYM-B). The board button sends the caste of the
    // row it sits on, an API caller may name one, and a task routed to an agent
    // uses that agent's caste. A task with none of the three keeps part A's
    // instance-level behaviour: the caste switch gates the castes that are
    // known, it does not invent one for an unrouted task.
    const casteKey = (input.casteKey?.trim() || issue.casteKey?.trim() || "") || null;
    let settings = resolution.settings;
    let prompts: DebatePromptOverrides = {};
    let caste: CasteDebateResolution | null = null;
    if (casteKey) {
      await requireCaste(input.companyId, casteKey);
      const read = await deps.readCasteSettings({ companyId: input.companyId, casteKey, instance: resolution });
      const gate = casteDebateGate(read.resolution);
      if (!gate.ok) {
        throw new DebateConfigError(gate.code, gate.reason);
      }
      caste = read.resolution;
      settings = read.resolution.settings;
      prompts = read.resolution.prompts;
    }
    if (!settings) {
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
      settings,
      call,
      prompts,
    });
    if (outcome.familyProblem) {
      throw new DebateConfigError("debate_config_rejected", outcome.familyProblem);
    }

    // The result carries the caste it ran for and the custom guidance it used,
    // so the document left on the task says whose debate this was. A part-A
    // run (no caste) leaves `casteKey` null and the list empty.
    const result: DebateOutcome = { ...outcome, casteKey, customPrompts: customPromptRoles(prompts) };
    const documentBody = renderDebateResultDocument(result);
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
        casteKey: caste?.casteKey ?? null,
        casteSource: caste?.source ?? null,
        casteOverrides: caste?.overrides ?? [],
        customPrompts: customPromptRoles(prompts),
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

    return { issueId: issue.id, documentKey: DEBATE_RESULT_DOCUMENT_KEY, outcome: result, costRecorded };
  }
}

/** Parse + validate one PATCH candidate against the shared schema path. */
function debateSettingsCandidate(raw: unknown): { ok: true; settings: DebateSettings } | { ok: false; problem: string } {
  // The instance-level PATCH does not carry per-caste entries (1.7-DEBATE-
  // ASYM-B): those are saved per caste, and a body with the map would be
  // silently normalized into the default configuration here.
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && DEBATE_CASTES_KEY in (raw as object)) {
    return {
      ok: false,
      problem: `the instance configuration does not carry per-caste entries — save them per caste (${DEBATE_CASTES_KEY} belongs to the caste settings)`,
    };
  }
  const resolution = resolveDebateSettings({ stored: raw });
  if (resolution.settings) return { ok: true, settings: resolution.settings };
  return { ok: false, problem: resolution.problem ?? "the debate configuration is not usable" };
}

export type { DebateOutcome };
