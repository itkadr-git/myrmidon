import { z } from "zod";

/**
 * Asymmetric debates (myrmidon 1.7 DEBATE-ASYM A).
 *
 * The board runs a structured disagreement about a task question between two
 * models of DIFFERENT families — a generator (constructive pole) and a critic
 * (adversarial pole, penalized for missing errors) — with a judge outside the
 * dispute deciding on the transcript. The owner rule is asymmetry: one shared
 * family for the two debaters is rejected before anything is called.
 *
 * This module holds the pure contract: the family table, the roll config with
 * its cross-family validation, the round/token limits, the engine (independent
 * first answers, at most 3 rounds, an agreement stop, a token-ceiling stop,
 * cost aggregation) and the result-document renderer. It is DB-free and
 * network-free by design: the server supplies a `call` function (the gateway),
 * so the same engine runs verbatim in tests with fake models. The cost of a
 * call is cents per 1K tokens; free models price at 0 and still count tokens.
 */

// ── Model families ──────────────────────────────────────────────────────────

/**
 * Extensible family table: a model id belongs to the family of the first entry
 * whose key is a substring of the lower-cased id. Order matters (more specific
 * first). Mirrors the table EVALS-JUDGE-FAMILY introduced for evals so both
 * contours answer "which family is this model" the same way.
 */
const MODEL_FAMILY_RULES: ReadonlyArray<readonly [string, string]> = [
  ["qwen", "qwen"],
  ["dashscope", "qwen"],
  ["gpt", "gpt"],
  ["o1", "gpt"],
  ["o3", "gpt"],
  ["openai", "gpt"],
  ["claude", "claude"],
  ["anthropic", "claude"],
  ["glm", "glm"],
  ["zhipu", "glm"],
  ["chatglm", "glm"],
  ["deepseek", "deepseek"],
  ["kimi", "kimi"],
  ["moonshot", "kimi"],
  ["gemini", "gemini"],
  ["llama", "llama"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  ["codellama", "llama"],
  ["yi", "yi"],
  ["doubao", "doubao"],
  ["ernie", "ernie"],
  ["phi", "phi"],
  ["command-r", "command"],
];

/** Family of a model id, or "unknown" when no rule matches. */
export function getModelFamily(modelId: string): string {
  const normalized = modelId.toLowerCase();
  for (const [needle, family] of MODEL_FAMILY_RULES) {
    if (normalized.includes(needle)) return family;
  }
  return "unknown";
}

// ── Bound constants (owner rules of the 1.7 wave) ───────────────────────────

/** Hard ceiling of debate rounds. A configuration asking for more is invalid. */
export const DEBATE_MAX_ROUNDS_LIMIT = 3;
/** Default rounds when nothing is configured. */
export const DEBATE_DEFAULT_ROUNDS = 3;
/** Default token ceiling for one debate (all calls, all roles). */
export const DEBATE_DEFAULT_TOKEN_CEILING = 50_000;
/** Default free-model ids per role (the wave rule: free models first). */
export const DEBATE_DEFAULT_GENERATOR_MODEL = "qwen-plus-free";
export const DEBATE_DEFAULT_CRITIC_MODEL = "glm-4-flash-free";
/** The judge family must differ from BOTH debaters; this default (deepseek)
 * satisfies that for the generator/critic defaults above. */
export const DEBATE_DEFAULT_JUDGE_MODEL = "deepseek-chat-free";
/** Where the settings row lives in `instance_settings.general`. */
export const DEBATE_SETTINGS_KEY = "debate";
/** Where the environment override lives (forced, deployment use). */
export const DEBATE_SETTINGS_ENV = "MYRMIDON_DEBATE_CONFIG";
/** The issue-document key of a debate result. */
export const DEBATE_RESULT_DOCUMENT_KEY = "debate-result";
/** Activity-log action of a finished debate. */
export const DEBATE_COMPLETED_ACTION = "debate.completed";
/** Activity-log action for a saved (or cleared) per-caste configuration. */
export const DEBATE_CASTE_SETTINGS_ACTION = "debate.caste_settings.saved";
/** Cost-event billing code so the BUDGET-CONFIG accounting sees debates. */
export const DEBATE_BILLING_CODE = "myrmidon-debate";

/**
 * Where the per-caste overrides live inside the same stored value as the
 * instance configuration (1.7-DEBATE-ASYM-B): `general.debate.castes.<key>`.
 * No migration — the stored value already owns the engine config and its
 * preserve key, and the map is read at run time like everything else here.
 */
export const DEBATE_CASTES_KEY = "castes";

/** Cap on a caste's custom role guidance (a prompt, not a document). */
export const DEBATE_CUSTOM_PROMPT_MAX_LENGTH = 2000;

// ── Stored configuration shape ──────────────────────────────────────────────

const roleConfigSchema = z
  .object({
    /** Model id served behind the gateway. */
    model: z.string().trim().min(1).max(200),
    /** Optional cents per 1K input tokens; null/absent — free (0). */
    inputCentsPer1k: z.number().finite().min(0).max(10000).nullish(),
    /** Optional cents per 1K output tokens; null/absent — free (0). */
    outputCentsPer1k: z.number().finite().min(0).max(10000).nullish(),
  })
  .strict();

export const debateSettingsSchema = z
  .object({
    generator: roleConfigSchema,
    critic: roleConfigSchema,
    judge: roleConfigSchema,
    /** Debate rounds, 1..3 (the owner rule: never more than three). */
    rounds: z.number().int().min(1).max(DEBATE_MAX_ROUNDS_LIMIT).optional(),
    /** Total-token ceiling across the whole debate. */
    tokenCeiling: z.number().int().min(1000).max(10_000_000).optional(),
  })
  .strict();

export type DebateRoleConfig = z.infer<typeof roleConfigSchema>;
export type DebateSettings = z.infer<typeof debateSettingsSchema>;

/**
 * The stored value (1.7-DEBATE-ASYM-B): the instance configuration plus the
 * optional per-caste override map. The three roles are optional here (but all
 * or nothing) so a value that carries ONLY the per-caste map is valid — a caste
 * entry can be saved on an instance whose instance-level configuration comes
 * from the environment or the default, and that must not read as malformed.
 * `castes` never reaches the engine; an unknown key still fails the parse.
 */
export const debateStoredSettingsSchema = z
  .object({
    generator: roleConfigSchema.optional(),
    critic: roleConfigSchema.optional(),
    judge: roleConfigSchema.optional(),
    rounds: z.number().int().min(1).max(DEBATE_MAX_ROUNDS_LIMIT).optional(),
    tokenCeiling: z.number().int().min(1000).max(10_000_000).optional(),
    [DEBATE_CASTES_KEY]: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => {
    const present = [value.generator, value.critic, value.judge].filter((role) => role !== undefined).length;
    return present === 0 || present === 3;
  }, { message: "the debate configuration needs all three roles (generator, critic, judge) or none of them" });

/**
 * The per-caste override map out of a raw stored value. Entries are NOT
 * validated here: one broken caste entry must not take the instance
 * configuration down — the caste resolver reports it for its own caste only.
 */
export function readStoredCastes(raw: unknown): { map: Record<string, unknown>; problem: string | null } {
  if (raw === null || raw === undefined || raw === "") return { map: {}, problem: null };
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      return { map: {}, problem: "the debate configuration is not valid JSON" };
    }
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { map: {}, problem: null };
  const bag = (json as Record<string, unknown>)[DEBATE_CASTES_KEY];
  if (bag === undefined || bag === null) return { map: {}, problem: null };
  if (typeof bag !== "object" || Array.isArray(bag)) {
    return { map: {}, problem: `the debate configuration is malformed: ${DEBATE_CASTES_KEY} is not an object` };
  }
  return { map: bag as Record<string, unknown>, problem: null };
}

/**
 * Cross-family validation of a parsed config (the asymmetry rule). Returns the
 * offending roles in human-readable form, or null when the config is admissible.
 * "unknown" families never collide: two ids no rule matched are treated as
 * different vendors, so the strict check stays conservative but not blocking.
 */
export function debateFamilyProblem(settings: DebateSettings): string | null {
  const g = getModelFamily(settings.generator.model);
  const c = getModelFamily(settings.critic.model);
  const j = getModelFamily(settings.judge.model);
  if (g === c && g !== "unknown") {
    return `generator and critic share the model family "${g}" — debates must be asymmetric (different families)`;
  }
  if (j === g || j === c) {
    return `the judge shares the family "${j}" with a debater — the judge must sit outside the dispute`;
  }
  return null;
}

export interface DebateSettingsResolution {
  settings: DebateSettings | null;
  /** Where the value came from. */
  source: "settings" | "env" | "default" | null;
  /** Why nothing usable was found (parse failure, family collision). */
  problem: string | null;
}

/** Parse + validate one raw value; null `settings` carries a `problem`. */
export function resolveDebateSettingsValue(raw: unknown, source: DebateSettingsResolution["source"]): DebateSettingsResolution {
  if (raw === null || raw === undefined || raw === "") {
    return { settings: null, source: null, problem: null };
  }
  if (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0) {
    // An empty saved object means "nothing chosen" (the UI clearing), not a
    // malformed config — the next level (env, then default) applies.
    return { settings: null, source: null, problem: null };
  }
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      return { settings: null, source, problem: "the debate configuration is not valid JSON" };
    }
  }
  const parsed = debateStoredSettingsSchema.safeParse(json);
  if (!parsed.success) {
    return {
      settings: null,
      source,
      problem: `the debate configuration is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
  }
  // The per-caste bag belongs to the caste resolver, not to the instance
  // configuration: the effective config is what the engine reads. A value that
  // carries only the bag (a caste entry saved while the instance configuration
  // is the env/default one) has no instance config of its own — fall through to
  // the next level instead of reporting a problem.
  const { [DEBATE_CASTES_KEY]: _castes, ...stored } = parsed.data as DebateSettings & { castes?: unknown };
  if (!stored.generator || !stored.critic || !stored.judge) {
    return { settings: null, source: null, problem: null };
  }
  const settings: DebateSettings = {
    generator: stored.generator,
    critic: stored.critic,
    judge: stored.judge,
    ...(stored.rounds !== undefined ? { rounds: stored.rounds } : {}),
    ...(stored.tokenCeiling !== undefined ? { tokenCeiling: stored.tokenCeiling } : {}),
  };
  const collision = debateFamilyProblem(settings);
  if (collision) return { settings: null, source, problem: collision };
  return { settings, source, problem: null };
}

/** The built-in default config (free models, different families, 3 rounds). */
export function defaultDebateSettings(): DebateSettings {
  return {
    generator: { model: DEBATE_DEFAULT_GENERATOR_MODEL },
    critic: { model: DEBATE_DEFAULT_CRITIC_MODEL },
    judge: { model: DEBATE_DEFAULT_JUDGE_MODEL },
    rounds: DEBATE_DEFAULT_ROUNDS,
    tokenCeiling: DEBATE_DEFAULT_TOKEN_CEILING,
  };
}

/**
 * The effective configuration and its source. Precedence follows the
 * BUDGET-CONFIG / RUNTIME-LIMITS shape: the stored instance-settings value
 * first, then the `MYRMIDON_DEBATE_CONFIG` environment override, then the
 * built-in default. A malformed or symmetric value at any level does NOT fall
 * through to the next level — the caller must report the problem, because
 * silently degrading an explicit operator config is worse than refusing.
 */
export function resolveDebateSettings(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): DebateSettingsResolution {
  if (options.stored !== undefined && options.stored !== null) {
    const fromStored = resolveDebateSettingsValue(options.stored, "settings");
    if (fromStored.settings || fromStored.problem) return fromStored;
  }
  const envRaw = (options.env ?? {})[DEBATE_SETTINGS_ENV]?.trim();
  if (envRaw) {
    const fromEnv = resolveDebateSettingsValue(envRaw, "env");
    if (fromEnv.settings || fromEnv.problem) return fromEnv;
  }
  return { settings: defaultDebateSettings(), source: "default", problem: null };
}

// ── The debate engine (pure) ────────────────────────────────────────────────

export type DebateRole = "generator" | "critic" | "judge";

export interface DebateCallContext {
  role: DebateRole;
  round: number;
  /** True for the judge's independent first answer. */
  independent: boolean;
}

/** Token counts the gateway reports for one call (usage field or estimate). */
export interface DebateUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DebateModelCall {
  (
    roleConfig: DebateRoleConfig,
    systemPrompt: string,
    userPrompt: string,
    context: DebateCallContext,
  ): Promise<{ text: string; usage: DebateUsage }>;
}

export const DEBATE_AGREE_MARKER = "[AGREE]";

/** Whether a critic turn signals agreement (stop condition). */
export function criticAgrees(criticText: string): boolean {
  return criticText.toUpperCase().includes(DEBATE_AGREE_MARKER);
}

/** The two stance poles. The owner rule: polar prompts, never the same ask. */
export function generatorSystemPrompt(): string {
  return [
    "You are the GENERATOR in an asymmetric debate. Your pole is constructive:",
    "propose and then defend the best concrete answer to the question.",
    "Answer directly and substantively. If, after the critic's round, you find",
    "a criticism valid, revise your position; if nothing remains unresolved,",
    "say so briefly. Never address the process itself — argue the question.",
  ].join(" ");
}

export function criticSystemPrompt(): string {
  return [
    "You are the CRITIC in an asymmetric debate. Your pole is adversarial:",
    "your job is to find every error, omission and risky assumption in the",
    "generator's position. You are penalized for a missed error, so do not",
    "soften: list concrete flaws. When the generator has genuinely resolved",
    `every flaw you raised, stop arguing and write ${DEBATE_AGREE_MARKER}.`,
  ].join(" ");
}

export function judgeSystemPrompt(): string {
  return [
    "You are the JUDGE, outside the dispute. You do not take a side and you",
    "do not continue the argument. Read the debate transcript and deliver the",
    "best answer to the original question, weighing the strongest argument on",
    "each side. Start with a line VERDICT: <one sentence>, then the reasoned",
    "answer and any residual risk the debate did not resolve.",
  ].join(" ");
}

/**
 * Custom per-role guidance (caste settings, 1.7-DEBATE-ASYM-B). The built-in
 * pole prompt always comes first and is never replaced.
 */
export type DebatePromptOverrides = Partial<Record<DebateRole, string>>;

/** The built-in pole prompt of one role. */
export function builtinRoleSystemPrompt(role: DebateRole): string {
  return role === "generator" ? generatorSystemPrompt() : role === "critic" ? criticSystemPrompt() : judgeSystemPrompt();
}

/**
 * The system prompt one role argues from: the built-in pole, then the caste's
 * custom guidance. The pole — and with it the critic's missed-error penalty —
 * always stays: a caste may narrow where the role looks, it cannot turn the
 * critic polite or the generator defensive.
 */
export function composeRoleSystemPrompt(role: DebateRole, custom?: string | null): string {
  const base = builtinRoleSystemPrompt(role);
  const extra = typeof custom === "string" ? custom.trim() : "";
  if (!extra) return base;
  return [
    base,
    "",
    `Caste guidance for this role — it narrows where to look, it does not change the pole above: ${extra}`,
  ].join("\n");
}

/** One transcript entry. */
export interface DebateTurn {
  role: DebateRole;
  /** 0 = the independent first answers, 1..n = the exchange rounds. */
  round: number;
  independent: boolean;
  model: string;
  family: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface DebateCostBreakdown {
  /** Cents accumulated up to the last call that was allowed. */
  totalCents: number;
  /** Cents of the call that crossed the ceiling — recorded, not charged. */
  ceilingCrossedCents: number;
  inputTokens: number;
  outputTokens: number;
  byRole: Record<DebateRole, number>;
  byModel: Record<string, number>;
}

export const DEBATE_STOP_REASONS = ["agreement", "rounds_exhausted", "token_ceiling", "rejected_config"] as const;
export type DebateStopReason = (typeof DEBATE_STOP_REASONS)[number];

export interface DebateOutcome {
  question: string;
  /** True when the debate ran at all (config passed the family check). */
  completed: boolean;
  stopReason: DebateStopReason | null;
  /** Why it stopped in human terms, including ceiling arithmetic. */
  stopDetail: string;
  roundsPlanned: number;
  roundsRun: number;
  tokenCeiling: number;
  tokensUsed: number;
  cost: DebateCostBreakdown;
  transcript: DebateTurn[];
  judgeVerdict: string | null;
  /** Family collision report (the caller refuses or warns from this). */
  familyProblem: string | null;
  roles: Record<DebateRole, { model: string; family: string }>;
  /** The caste the debate ran for, when it ran from a caste's task (part B). */
  casteKey?: string | null;
  /** Roles that argued with custom caste guidance. */
  customPrompts?: DebateRole[];
}

export interface DebateEngineInput {
  question: string;
  settings: DebateSettings;
  call: DebateModelCall;
  /**
   * Custom per-role guidance from the caste settings (1.7-DEBATE-ASYM-B): it
   * is appended to the built-in pole prompt, never instead of it.
   */
  prompts?: DebatePromptOverrides;
}

/** The cost rule: cents = input/1k*inPrice + output/1k*outPrice, ceil to a cent. */
export function debateCallCostCents(roleConfig: DebateRoleConfig, usage: DebateUsage): number {
  const inPrice = roleConfig.inputCentsPer1k ?? 0;
  const outPrice = roleConfig.outputCentsPer1k ?? 0;
  const cents = (usage.inputTokens / 1000) * inPrice + (usage.outputTokens / 1000) * outPrice;
  return Math.max(0, Math.round(cents));
}

function newBreakdown(): DebateCostBreakdown {
  return {
    totalCents: 0,
    ceilingCrossedCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    byRole: { generator: 0, critic: 0, judge: 0 },
    byModel: {},
  };
}

function addCost(breakdown: DebateCostBreakdown, turn: DebateTurn): void {
  breakdown.totalCents += turn.costCents;
  breakdown.inputTokens += turn.inputTokens;
  breakdown.outputTokens += turn.outputTokens;
  breakdown.byRole[turn.role] += turn.costCents;
  breakdown.byModel[turn.model] = (breakdown.byModel[turn.model] ?? 0) + turn.costCents;
}

function tokensOf(usage: DebateUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Run one asymmetric debate. Pure: every model call goes through `call`, so
 * the same engine runs against fakes in tests and the gateway in production.
 *
 * The shape:
 *  1. Independent first answers. The generator answers the question with no
 *     history; the critic answers the same question seeing ONLY the question
 *     (its own initial stance) — neither sees the other's first answer, per
 *     the owner rule.
 *  2. Rounds 1..`rounds` (≤ 3): the generator revises against the critic's
 *     position, then the critic attacks the revised position; a critic turn
 *     carrying the agreement marker ends the exchange early.
 *  3. The judge (a third family) reads the whole transcript and rules.
 *
 * Token ceiling: before each exchange call the engine projects the next call
 * at a fixed allowance. A call that would take the total past the ceiling is
 * refused without being made; if the crossing happens on a call that only
 * reveals its usage after running, the overrun is recorded in
 * `ceilingCrossedCents` and excluded from `totalCents` (charged cost = the
 * calls covered by the ceiling), and the debate stops with `token_ceiling`.
 * The judge is the outside arbiter and always runs unless its projected call
 * alone is already over a ceiling that nothing was spent on.
 */
export async function runDebate(input: DebateEngineInput): Promise<DebateOutcome> {
  const { question, settings, call } = input;
  const familyProblem = debateFamilyProblem(settings);
  const roles: Record<DebateRole, { model: string; family: string }> = {
    generator: { model: settings.generator.model, family: getModelFamily(settings.generator.model) },
    critic: { model: settings.critic.model, family: getModelFamily(settings.critic.model) },
    judge: { model: settings.judge.model, family: getModelFamily(settings.judge.model) },
  };
  const roundsPlanned = settings.rounds ?? DEBATE_DEFAULT_ROUNDS;
  const tokenCeiling = settings.tokenCeiling ?? DEBATE_DEFAULT_TOKEN_CEILING;

  if (familyProblem) {
    return {
      question,
      completed: false,
      stopReason: "rejected_config",
      stopDetail: familyProblem,
      roundsPlanned,
      roundsRun: 0,
      tokenCeiling,
      tokensUsed: 0,
      cost: newBreakdown(),
      transcript: [],
      judgeVerdict: null,
      familyProblem,
      roles,
    };
  }

  const transcript: DebateTurn[] = [];
  const cost = newBreakdown();
  let tokensUsed = 0;

  async function run(
    role: DebateRole,
    round: number,
    independent: boolean,
    userPrompt: string,
  ): Promise<DebateTurn | null> {
    const roleConfig = settings[role];
    const system = composeRoleSystemPrompt(role, input.prompts?.[role] ?? null);
    const res = await call(roleConfig, system, userPrompt, { role, round, independent });
    const usage = res.usage;
    const turnTokens = tokensOf(usage);
    const turn: DebateTurn = {
      role,
      round,
      independent,
      model: roleConfig.model,
      family: roles[role].family,
      text: res.text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCents: debateCallCostCents(roleConfig, usage),
    };
    if (tokensUsed + turnTokens > tokenCeiling) {
      // The call ran and crossed the ceiling: record the overrun separately,
      // do not charge it, stop.
      cost.ceilingCrossedCents += turn.costCents;
      transcript.push(turn);
      return null;
    }
    tokensUsed += turnTokens;
    addCost(cost, turn);
    transcript.push(turn);
    return turn;
  }

  // 1. Independent first answers (critic never sees the generator's answer).
  const firstGenerator = await run("generator", 0, true, `Question: ${question}`);
  if (firstGenerator === null) {
    return finish(question, roles, settings, transcript, cost, tokensUsed, tokenCeiling, roundsPlanned, 0, "token_ceiling", "the token ceiling was crossed during the generator's first answer; no judge ran", null);
  }
  const firstCritic = await run("critic", 0, true, `Question: ${question}`);
  if (firstCritic === null) {
    return finish(question, roles, settings, transcript, cost, tokensUsed, tokenCeiling, roundsPlanned, 0, "token_ceiling", "the token ceiling was crossed during the critic's first answer; no judge ran", null);
  }

  // 2. The exchange: at most `roundsPlanned` rounds. Before each call the
  // engine projects the next call against the remaining ceiling.
  let lastGeneratorText = firstGenerator.text;
  let lastCriticText = firstCritic.text;
  let roundsRun = 0;
  let stopReason: DebateStopReason = "rounds_exhausted";
  let stopDetail = `the debate used its ${roundsPlanned} planned rounds without agreement`;

  const PROJECTED_CALL_TOKENS = 4000;

  for (let round = 1; round <= roundsPlanned; round += 1) {
    if (tokensUsed + PROJECTED_CALL_TOKENS > tokenCeiling) {
      stopReason = "token_ceiling";
      stopDetail = `stopped before round ${round}: only ${tokenCeiling - tokensUsed} tokens of the ${tokenCeiling} ceiling remain`;
      roundsRun = round - 1;
      break;
    }
    const gen = await run(
      "generator",
      round,
      false,
      `Question: ${question}\n\nThe critic's position:\n${lastCriticText}\n\nRevise or defend your answer.`,
    );
    if (gen === null) {
      stopReason = "token_ceiling";
      stopDetail = `the token ceiling (${tokenCeiling}) was crossed in round ${round} (generator call)`;
      roundsRun = round;
      break;
    }
    lastGeneratorText = gen.text;

    if (tokensUsed + PROJECTED_CALL_TOKENS > tokenCeiling) {
      stopReason = "token_ceiling";
      stopDetail = `stopped after the generator's turn in round ${round}: only ${tokenCeiling - tokensUsed} tokens of the ${tokenCeiling} ceiling remain`;
      roundsRun = round;
      break;
    }
    const crit = await run(
      "critic",
      round,
      false,
      `Question: ${question}\n\nThe generator's current answer:\n${lastGeneratorText}\n\nAttack it: list the errors, omissions and risks you find. If nothing remains unresolved, write ${DEBATE_AGREE_MARKER}.`,
    );
    if (crit === null) {
      stopReason = "token_ceiling";
      stopDetail = `the token ceiling (${tokenCeiling}) was crossed in round ${round} (critic call)`;
      roundsRun = round;
      break;
    }
    lastCriticText = crit.text;
    roundsRun = round;

    if (criticAgrees(crit.text)) {
      stopReason = "agreement";
      stopDetail = `the critic signalled agreement in round ${round}; the exchange stopped early`;
      break;
    }
  }

  // 3. The judge sits outside the dispute and always gets its turn: the
  // exchange has run at least the two independent first answers by now.
  const transcriptText = transcript
    .map((t) => `[${t.role}${t.independent ? " (independent)" : ` round ${t.round}`}] ${t.text}`)
    .join("\n\n");
  let judgeVerdict: string | null = null;
  const judged = await run(
    "judge",
    roundsRun,
    false,
    `Question: ${question}\n\nDebate transcript:\n\n${transcriptText}\n\nDeliver your verdict and answer.`,
  );
  if (judged === null) {
    stopReason = "token_ceiling";
    stopDetail = `the token ceiling (${tokenCeiling}) was crossed at the judge call; the verdict could not be recorded`;
  } else {
    judgeVerdict = judged.text;
  }

  return finish(question, roles, settings, transcript, cost, tokensUsed, tokenCeiling, roundsPlanned, roundsRun, stopReason, stopDetail, judgeVerdict);
}

function finish(
  question: string,
  roles: Record<DebateRole, { model: string; family: string }>,
  settings: DebateSettings,
  transcript: DebateTurn[],
  cost: DebateCostBreakdown,
  tokensUsed: number,
  tokenCeiling: number,
  roundsPlanned: number,
  roundsRun: number,
  stopReason: DebateStopReason,
  stopDetail: string,
  judgeVerdict: string | null,
): DebateOutcome {
  return {
    question,
    completed: judgeVerdict !== null,
    stopReason,
    stopDetail,
    roundsPlanned,
    roundsRun,
    tokenCeiling,
    tokensUsed,
    cost,
    transcript,
    judgeVerdict,
    familyProblem: null,
    roles: { ...roles },
  };
}

// ── The result document ─────────────────────────────────────────────────────

function dollar(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The debate result as a markdown document for the task. The owner acceptance
 * rule: the document must carry the cost. No secret values ever appear here —
 * only model names, families, token counts and cents.
 */
export function renderDebateResultDocument(outcome: DebateOutcome): string {
  const lines: string[] = [];
  lines.push(`# Debate result`);
  lines.push("");
  lines.push(`**Question.** ${outcome.question}`);
  lines.push("");
  lines.push(`## Roles`);
  lines.push("");
  if (outcome.casteKey) {
    const custom = outcome.customPrompts?.length ? ` — custom guidance: ${outcome.customPrompts.join(", ")}` : "";
    lines.push(`Caste: **${outcome.casteKey}**${custom}`);
    lines.push("");
  }
  lines.push("| Role | Model | Family |");
  lines.push("| --- | --- | --- |");
  for (const role of ["generator", "critic", "judge"] as const) {
    lines.push(`| ${role} | ${outcome.roles[role].model} | ${outcome.roles[role].family} |`);
  }
  lines.push("");
  lines.push(`## Outcome`);
  lines.push("");
  lines.push(`- Rounds: ${outcome.roundsRun} of ${outcome.roundsPlanned} planned`);
  lines.push(`- Stopped: ${outcome.stopReason ?? "n/a"} — ${outcome.stopDetail}`);
  lines.push(`- Tokens: ${outcome.tokensUsed} of ${outcome.tokenCeiling} ceiling`);
  lines.push("");
  lines.push(`## Cost`);
  lines.push("");
  lines.push(`| Role | Cost |`);
  lines.push(`| --- | --- |`);
  for (const role of ["generator", "critic", "judge"] as const) {
    lines.push(`| ${role} | ${dollar(outcome.cost.byRole[role])} |`);
  }
  lines.push(`| **Total** | **${dollar(outcome.cost.totalCents)}** |`);
  if (outcome.cost.ceilingCrossedCents > 0) {
    lines.push("");
    lines.push(`The call that crossed the token ceiling cost ${dollar(outcome.cost.ceilingCrossedCents)} and is NOT included in the total.`);
  }
  lines.push("");
  lines.push(`## Positions (transcript)`);
  for (const turn of outcome.transcript) {
    lines.push("");
    lines.push(`### ${turn.role}${turn.independent ? " — independent first answer" : ` — round ${turn.round}`}`);
    lines.push("");
    lines.push(turn.text);
  }
  lines.push("");
  lines.push(`## Judge verdict`);
  lines.push("");
  lines.push(outcome.judgeVerdict ?? "_No verdict: the debate stopped before the judge ran._");
  lines.push("");
  return lines.join("\n");
}
