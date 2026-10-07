import { z } from "zod";

/**
 * Discussion room on an issue (myrmidon 1.7 AGENT-EXCHANGE A).
 *
 * The owner opens a room on a task: 2–4 participants, each a named model of a
 * company model provider. Round 1 is *independent*: every participant answers
 * the opening prompt without seeing the others, so the first round is four
 * opinions, not one opinion and three echoes. From round 2 on a participant
 * sees the previous round in full. When the participants stop adding
 * anything (or the round cap is reached) the finisher — a separate model
 * call — compresses the room into a summary that lands as an issue document
 * (`exchange:<roomId>`) together with what the room cost.
 *
 * The owner keeps the stop valve: `stop` ends the room immediately. A stopped
 * room makes NO further model calls — not even the finisher (the caller may
 * finalize explicitly with `finalize: true` when the owner wants the summary
 * of a stopped room).
 *
 * DEBATE-ASYM (the role/judge mechanics) is not merged yet; the seam is the
 * `DebateAsymPort` in `server/src/myrmidon/agent-exchange/service.ts`. While
 * the port is absent the room runs the plain flow below and the record stays
 * in the neutral `judge: null` state — no import of the unmerged module.
 *
 * The values below are decided here once and read from both the server and
 * the settings page (the same precedence the other myrmidon settings use):
 * the stored settings value, then the environment variable (a forced
 * override), then the built-in default. The resolver reports per key where
 * the effective value came from.
 */

/** Environment variables — forced overrides of the stored settings. */
export const AGENT_EXCHANGE_ENV_KEYS = {
  enabled: "MYRMIDON_AGENT_EXCHANGE_ENABLED",
  maxParticipants: "MYRMIDON_AGENT_EXCHANGE_MAX_PARTICIPANTS",
  maxRounds: "MYRMIDON_AGENT_EXCHANGE_MAX_ROUNDS",
  tokenBudget: "MYRMIDON_AGENT_EXCHANGE_TOKEN_BUDGET",
  responseTimeoutMs: "MYRMIDON_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS",
} as const;

/** Stored-settings key inside `instance_settings.general`. */
export const AGENT_EXCHANGE_SETTINGS_KEY = "agentExchange";

export const AGENT_EXCHANGE_SETTING_KEYS = [
  "enabled",
  "maxParticipants",
  "maxRounds",
  "tokenBudget",
  "responseTimeoutMs",
] as const;

export type AgentExchangeSettingKey = (typeof AGENT_EXCHANGE_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type AgentExchangeSettingSource = "settings" | "env" | "default";

/** Master switch. Ships dark: a typo must never start paid model calls. */
export const DEFAULT_AGENT_EXCHANGE_ENABLED = false;

/** Room size. The brief pins 2–4 participants; the upper bound is a setting. */
export const DEFAULT_AGENT_EXCHANGE_MAX_PARTICIPANTS = 4;
export const MIN_AGENT_EXCHANGE_PARTICIPANTS = 2;
export const MAX_AGENT_EXCHANGE_MAX_PARTICIPANTS = 8;

/** Rounds after round 1 are visible-to-all; the cap stops an endless exchange. */
export const DEFAULT_AGENT_EXCHANGE_MAX_ROUNDS = 3;
export const MIN_AGENT_EXCHANGE_MAX_ROUNDS = 1;
export const MAX_AGENT_EXCHANGE_MAX_ROUNDS = 10;

/**
 * Per-room token ceiling (prompt + completion tokens of every model call of
 * the room, the finisher included). A room that reaches the ceiling stops
 * accepting rounds; the finisher may still run while its own estimated
 * prompt fits the remainder. `null` would mean "no ceiling" — deliberately
 * not offered: every room has a price tag.
 */
export const DEFAULT_AGENT_EXCHANGE_TOKEN_BUDGET = 100_000;
export const MIN_AGENT_EXCHANGE_TOKEN_BUDGET = 1_000;
export const MAX_AGENT_EXCHANGE_TOKEN_BUDGET = 2_000_000;

/** How long one participant call may take before it is recorded as an error. */
export const DEFAULT_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS = 120_000;
export const MIN_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS = 5_000;
export const MAX_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS = 600_000;

/** The status of a room. */
export const AGENT_EXCHANGE_ROOM_STATUSES = ["open", "stopped", "completed"] as const;
export type AgentExchangeRoomStatus = (typeof AGENT_EXCHANGE_ROOM_STATUSES)[number];

/** The status of one participant message. */
export const AGENT_EXCHANGE_MESSAGE_STATUSES = ["pending", "done", "error"] as const;
export type AgentExchangeMessageStatus = (typeof AGENT_EXCHANGE_MESSAGE_STATUSES)[number];

/** Who is allowed to open a room / pull the stop valve. */
export const AGENT_EXCHANGE_ACTOR_TYPES = ["user", "agent"] as const;
export type AgentExchangeActorType = (typeof AGENT_EXCHANGE_ACTOR_TYPES)[number];

/** One participant slot of a room. */
export interface AgentExchangeParticipantSpec {
  /** The company agent whose name labels the answers, when the room names one. */
  agentId: string | null;
  /** Free-text label when no agent is named (`agent-a` in tests). */
  label: string;
  /** The company model provider the call goes through. */
  providerId: string;
  /** The provider's model name (`gpt-…`, `claude-…`, …). */
  model: string;
}

/** One message of a participant — one cell of the round grid. */
export interface AgentExchangeMessage {
  id: string;
  roomId: string;
  /** `round >= 1`; the finisher is not a round and has no message. */
  round: number;
  participantIndex: number;
  status: AgentExchangeMessageStatus;
  /** The answer; null until the call lands. */
  content: string | null;
  /** `participant_error:<code>` on a failed call; null on a landed one. */
  error: string | null;
  promptTokens: number;
  completionTokens: number;
  costCents: number;
  createdAt: string;
  completedAt: string | null;
}

/** The room record the API and the settings screen render. */
export interface AgentExchangeRoom {
  id: string;
  companyId: string;
  issueId: string;
  status: AgentExchangeRoomStatus;
  openerType: AgentExchangeActorType;
  openerId: string;
  /** The stop valve: who may stop the room. */
  stopperType: AgentExchangeActorType;
  stopperId: string;
  participants: AgentExchangeParticipantSpec[];
  /** The finisher model; defaults to the first participant when null. */
  finisher: { providerId: string; model: string } | null;
  maxRounds: number;
  tokenBudget: number;
  tokensUsed: number;
  costCents: number;
  /** `owner_stop` when the stop valve ended the room. */
  stopReason: string | null;
  /** The issue-document key the summary was written to. */
  summaryDocumentKey: string | null;
  /** Seam for DEBATE-ASYM: the judge's verdict, while unmerged always null. */
  judge: unknown | null;
  currentRound: number;
  createdAt: string;
  closedAt: string | null;
}

/** The zod contract of `POST …/agent-exchange/rooms`. */
export const agentExchangeCreateRoomSchema = z
  .object({
    issueId: z.string().uuid(),
    participants: z
      .array(
        z
          .object({
            agentId: z.string().uuid().nullish(),
            label: z.string().trim().min(1).max(120),
            providerId: z.string().uuid(),
            model: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(MIN_AGENT_EXCHANGE_PARTICIPANTS)
      .max(MAX_AGENT_EXCHANGE_MAX_PARTICIPANTS),
    finisher: z
      .object({
        providerId: z.string().uuid(),
        model: z.string().trim().min(1).max(200),
      })
      .strict()
      .nullish(),
    maxRounds: z.number().int().min(MIN_AGENT_EXCHANGE_MAX_ROUNDS).max(MAX_AGENT_EXCHANGE_MAX_ROUNDS).optional(),
    tokenBudget: z.number().int().min(MIN_AGENT_EXCHANGE_TOKEN_BUDGET).max(MAX_AGENT_EXCHANGE_TOKEN_BUDGET).optional(),
    /** The opening prompt. Falls back to the issue title + description. */
    prompt: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();

export type AgentExchangeCreateRoomInput = z.infer<typeof agentExchangeCreateRoomSchema>;

/** Body of the stop-valve call. */
export const agentExchangeStopSchema = z
  .object({
    /** true — the finisher still runs and the summary is written. Default false. */
    finalize: z.boolean().optional(),
  })
  .strict();

export type AgentExchangeStopInput = z.infer<typeof agentExchangeStopSchema>;

/** The stored settings shape of `general.agentExchange`. */
export const agentExchangeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    maxParticipants: z.number().int().min(MIN_AGENT_EXCHANGE_PARTICIPANTS).max(MAX_AGENT_EXCHANGE_MAX_PARTICIPANTS),
    maxRounds: z.number().int().min(MIN_AGENT_EXCHANGE_MAX_ROUNDS).max(MAX_AGENT_EXCHANGE_MAX_ROUNDS),
    tokenBudget: z.number().int().min(MIN_AGENT_EXCHANGE_TOKEN_BUDGET).max(MAX_AGENT_EXCHANGE_TOKEN_BUDGET),
    responseTimeoutMs: z.number().int().min(MIN_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS).max(MAX_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS),
  })
  .strict();

export type AgentExchangeSettings = z.infer<typeof agentExchangeSettingsSchema>;

/** Body of `PATCH /api/myrmidon/agent-exchange/settings`. */
export const patchAgentExchangeSettingsSchema = agentExchangeSettingsSchema.partial().strict();

export type AgentExchangeSettingsPatch = z.infer<typeof patchAgentExchangeSettingsSchema>;

export const DEFAULT_AGENT_EXCHANGE_SETTINGS: AgentExchangeSettings = {
  enabled: DEFAULT_AGENT_EXCHANGE_ENABLED,
  maxParticipants: DEFAULT_AGENT_EXCHANGE_MAX_PARTICIPANTS,
  maxRounds: DEFAULT_AGENT_EXCHANGE_MAX_ROUNDS,
  tokenBudget: DEFAULT_AGENT_EXCHANGE_TOKEN_BUDGET,
  responseTimeoutMs: DEFAULT_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS,
};

export interface ResolvedAgentExchangeSettings {
  settings: AgentExchangeSettings;
  sources: Record<AgentExchangeSettingKey, AgentExchangeSettingSource>;
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeAgentExchangeSettings(raw: unknown): AgentExchangeSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = agentExchangeSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseEnvBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "1" || trimmed === "true") return true;
  if (trimmed === "0" || trimmed === "false") return false;
  return null;
}

function parseEnvInt(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/**
 * The effective settings and where each key came from. Stored settings win
 * when the row parses (a partial hand-edit that fails the strict schema is
 * ignored whole — the same "one key, one object" rule the other myrmidon
 * settings follow); a present-but-unreadable environment value falls through
 * to the default rather than blocking the stored value.
 */
export function resolveAgentExchangeSettings(input: {
  stored: unknown;
  env?: Record<string, string | undefined>;
}): ResolvedAgentExchangeSettings {
  const env = input.env ?? process.env;
  const stored = normalizeAgentExchangeSettings(input.stored);

  const settings: AgentExchangeSettings = { ...DEFAULT_AGENT_EXCHANGE_SETTINGS };
  const sources = {} as Record<AgentExchangeSettingKey, AgentExchangeSettingSource>;
  for (const key of AGENT_EXCHANGE_SETTING_KEYS) sources[key] = "default";

  if (stored) {
    // The schema guarantees every key; the spread keeps the exact per-key types.
    Object.assign(settings, stored);
    for (const key of AGENT_EXCHANGE_SETTING_KEYS) sources[key] = "settings";
    // A stored row wins whole over the environment (the same precedence the
    // other myrmidon settings follow: the settings page is the master copy,
    // the environment only forces keys that nobody stored yet).
    return { settings, sources };
  }

  const envEnabled = parseEnvBoolean(env[AGENT_EXCHANGE_ENV_KEYS.enabled]);
  if (envEnabled !== null) {
    settings.enabled = envEnabled;
    sources.enabled = "env";
  }
  const envMaxParticipants = parseEnvInt(
    env[AGENT_EXCHANGE_ENV_KEYS.maxParticipants],
    MIN_AGENT_EXCHANGE_PARTICIPANTS,
    MAX_AGENT_EXCHANGE_MAX_PARTICIPANTS,
  );
  if (envMaxParticipants !== null) {
    settings.maxParticipants = envMaxParticipants;
    sources.maxParticipants = "env";
  }
  const envMaxRounds = parseEnvInt(
    env[AGENT_EXCHANGE_ENV_KEYS.maxRounds],
    MIN_AGENT_EXCHANGE_MAX_ROUNDS,
    MAX_AGENT_EXCHANGE_MAX_ROUNDS,
  );
  if (envMaxRounds !== null) {
    settings.maxRounds = envMaxRounds;
    sources.maxRounds = "env";
  }
  const envTokenBudget = parseEnvInt(
    env[AGENT_EXCHANGE_ENV_KEYS.tokenBudget],
    MIN_AGENT_EXCHANGE_TOKEN_BUDGET,
    MAX_AGENT_EXCHANGE_TOKEN_BUDGET,
  );
  if (envTokenBudget !== null) {
    settings.tokenBudget = envTokenBudget;
    sources.tokenBudget = "env";
  }
  const envTimeout = parseEnvInt(
    env[AGENT_EXCHANGE_ENV_KEYS.responseTimeoutMs],
    MIN_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS,
    MAX_AGENT_EXCHANGE_RESPONSE_TIMEOUT_MS,
  );
  if (envTimeout !== null) {
    settings.responseTimeoutMs = envTimeout;
    sources.responseTimeoutMs = "env";
  }

  return { settings, sources };
}

/**
 * The cost of one landed call in cents, from the per-token prices the model
 * catalog carries (USD per 1M tokens, as in litellm-costs). Unknown prices
 * cost 0 — the room never invents a price; the summary then says "cost
 * unknown" via the tokens.
 */
export function agentExchangeCallCostCents(input: {
  promptTokens: number;
  completionTokens: number;
  /** USD per 1M prompt tokens; null when the catalog does not know. */
  promptPriceUsdPerMillion: number | null;
  completionPriceUsdPerMillion: number | null;
}): number {
  if (input.promptPriceUsdPerMillion === null || input.completionPriceUsdPerMillion === null) return 0;
  const usd =
    (input.promptTokens * input.promptPriceUsdPerMillion +
      input.completionTokens * input.completionPriceUsdPerMillion) /
    1_000_000;
  return Math.round(usd * 10000) / 100; // hundredths of a cent, two decimals of a cent
}

/**
 * Rough token estimate of one outgoing message, for the budget pre-check:
 * ~4 characters per token, the same rule of thumb the prompt-budget module
 * uses. A pre-check is a floor, not a promise — the landed usage is what the
 * room records.
 */
export function estimateAgentExchangeTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
