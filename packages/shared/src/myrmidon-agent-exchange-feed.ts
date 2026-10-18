import { z } from "zod";

/**
 * The owner-facing feed of discussion rooms (myrmidon 1.7 AGENT-EXCHANGE B).
 *
 * Part A ships the room itself: agents exchange answers on an issue card and
 * the finisher writes the summary as an issue document with the cost. Part B
 * turns that into something the owner can use from a screen:
 *
 * 1. a feed of the rooms of the company — the outcome, the price tag and the
 *    link back to the task — assembled from the room records of part A;
 * 2. one button per summarized room that turns the outcome into a *candidate*
 *    skill of SKILL-LIFECYCLE: the skill exists in the company library, it is
 *    registered as `candidate` and it waits for the existing approvals
 *    pipeline (`skill_promotion`). Nothing is promoted automatically — the
 *    button only proposes;
 * 3. the behaviour switches below, changed on the settings screen without a
 *    restart (the environment stays a forced override for an instance that
 *    never saved its settings, the same precedence shape part A uses).
 *
 * The candidate is keyed deterministically from the room (`exchange-room-<id>`),
 * so pressing the button twice is a no-op that returns the same skill; no
 * extra column on the room table is needed and no second write path appears.
 */

/** Environment variables — forced overrides of the stored settings. */
export const AGENT_EXCHANGE_FEED_ENV_KEYS = {
  feedLimit: "MYRMIDON_AGENT_EXCHANGE_FEED_LIMIT",
  skillCandidateEnabled: "MYRMIDON_AGENT_EXCHANGE_SKILL_CANDIDATE_ENABLED",
} as const;

/** Stored-settings key inside `instance_settings.general`. */
export const AGENT_EXCHANGE_FEED_SETTINGS_KEY = "agentExchangeFeed";

export const AGENT_EXCHANGE_FEED_SETTING_KEYS = ["feedLimit", "skillCandidateEnabled"] as const;

export type AgentExchangeFeedSettingKey = (typeof AGENT_EXCHANGE_FEED_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type AgentExchangeFeedSettingSource = "settings" | "env" | "default";

/**
 * How many rooms the feed answers with. The feed is a reading screen, not an
 * export: a cap keeps one company with thousands of rooms from answering with
 * a megabyte, and the screen says when the list was cut.
 */
export const DEFAULT_AGENT_EXCHANGE_FEED_LIMIT = 50;
export const MIN_AGENT_EXCHANGE_FEED_LIMIT = 5;
export const MAX_AGENT_EXCHANGE_FEED_LIMIT = 200;

/**
 * Whether the «to skill» button is offered at all. On by default: the action
 * is a local write (create the skill, register it as a candidate) with no
 * model call and no spend, and the room feature itself is dark until part A's
 * master switch is on. Turning it off leaves the feed readable.
 */
export const DEFAULT_AGENT_EXCHANGE_SKILL_CANDIDATE_ENABLED = true;

/** One participant line of the feed row (the label the owner saw in the room). */
export interface AgentExchangeFeedParticipant {
  label: string;
  model: string;
}

/** The candidate a summarized room already produced, if any. */
export interface AgentExchangeFeedSkillCandidate {
  skillId: string;
  key: string;
  name: string;
  /** Always `candidate`: the feed never sees a promoted skill as a candidate. */
  state: string;
}

/** One room of the feed: the outcome, the price tag and the task link. */
export interface AgentExchangeFeedRoom {
  roomId: string;
  issueId: string;
  /** `OPE-1234` when the task has an identifier (the owner-facing link label). */
  issueIdentifier: string | null;
  issueTitle: string | null;
  status: string;
  stopReason: string | null;
  participants: AgentExchangeFeedParticipant[];
  currentRound: number;
  maxRounds: number;
  tokensUsed: number;
  /**
   * The cost as part A recorded it: hundredths of a cent (see `costKnown` and
   * `agentExchangeCallCostCents`). The screen divides by 10 000 for dollars.
   */
  costCents: number;
  /**
   * False when the room spent tokens but the model catalog carried no price:
   * part A records 0 for an unknown price, so the screen says "unknown"
   * instead of claiming the room was free.
   */
  costKnown: boolean;
  /** The key of the summary document on the issue (`exchange:<roomId>`). */
  summaryDocumentKey: string | null;
  /** True when the room has an outcome the button can turn into a skill. */
  summarized: boolean;
  skillCandidate: AgentExchangeFeedSkillCandidate | null;
  createdAt: string;
  closedAt: string | null;
}

/** The company totals under the feed list. */
export interface AgentExchangeFeedTotals {
  rooms: number;
  summarizedRooms: number;
  candidateRooms: number;
  tokensUsed: number;
  costCents: number;
  costUnknownRooms: number;
}

/** The answer of `GET /api/myrmidon/companies/:companyId/agent-exchange/feed`. */
export interface AgentExchangeFeedResponse {
  rooms: AgentExchangeFeedRoom[];
  totals: AgentExchangeFeedTotals;
  /** The applied cap. */
  limit: number;
  /** True when the company has more rooms than the cap answered with. */
  truncated: boolean;
  /** Mirrors the setting, so the screen hides the button when it is off. */
  skillCandidateEnabled: boolean;
}

/** Body of the «to skill» call. Both fields are optional refinements. */
export const agentExchangeSkillCandidateSchema = z
  .object({
    /** Overrides the derived name of the candidate skill. */
    name: z.string().trim().min(1).max(120).optional(),
    /** Optional note stored in the skill body (why this outcome is worth keeping). */
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export type AgentExchangeSkillCandidateInput = z.infer<typeof agentExchangeSkillCandidateSchema>;

/** The answer of the «to skill» call. */
export interface AgentExchangeSkillCandidateResult {
  skillId: string;
  key: string;
  name: string;
  state: string;
  /** False when the room already had its candidate (the call is idempotent). */
  created: boolean;
  /** Always true: the candidate waits for an approval, nothing is promoted here. */
  promotionRequired: true;
}

/** The slug prefix of a room candidate, so the feed can find it without a column. */
export const AGENT_EXCHANGE_SKILL_SLUG_PREFIX = "exchange-room-";

/**
 * The deterministic skill slug of a room. Room ids are uuids (lowercase hex
 * and dashes), so the slug is already in the shape `normalizeSkillSlug`
 * produces and stays stable across calls — which is what makes the button
 * idempotent and lets the feed map a room to its candidate by key.
 */
export function agentExchangeRoomSkillSlug(roomId: string): string {
  return `${AGENT_EXCHANGE_SKILL_SLUG_PREFIX}${roomId.trim().toLowerCase()}`;
}

/** The company skill key of a candidate slug, as `company/${companyId}/${slug}`. */
export function agentExchangeCompanySkillKey(companyId: string, slug: string): string {
  return `company/${companyId}/${slug}`;
}

/** The company skill key of a room candidate, as `company/${companyId}/${slug}`. */
export function agentExchangeRoomSkillKey(companyId: string, roomId: string): string {
  return agentExchangeCompanySkillKey(companyId, agentExchangeRoomSkillSlug(roomId));
}

/** The default name of the candidate derived from the room's task. */
export function agentExchangeRoomCandidateName(input: {
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  roomId: string;
}): string {
  const label = input.issueIdentifier?.trim() || input.issueTitle?.trim();
  if (label) return `Exchange room: ${label}`.slice(0, 120);
  return `Exchange room: ${input.roomId.slice(0, 8)}`;
}

/**
 * The SKILL.md body of a room candidate: the outcome first, then the
 * provenance the owner needs to judge it (which task, which room, what it
 * cost), then the optional note. `summary` is the finisher's document text as
 * part A wrote it — the candidate embeds it instead of inventing anything.
 */
export function buildAgentExchangeSkillCandidateMarkdown(input: {
  name: string;
  description: string;
  summary: string;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  issueId: string;
  roomId: string;
  participants: AgentExchangeFeedParticipant[];
  tokensUsed: number;
  costCents: number;
  costKnown: boolean;
  note?: string | null;
}): string {
  const costLabel = input.costKnown
    ? `$${(input.costCents / 10_000).toFixed(4)}`
    : "unknown (no price for the model)";
  const participantLine =
    input.participants.map((p) => `${p.label} (${p.model})`).join(", ") || "not recorded";
  const taskLine = [input.issueIdentifier, input.issueTitle].filter(Boolean).join(" — ") || input.issueId;
  const lines = [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    "---",
    "",
    `# ${input.name}`,
    "",
    "## Outcome",
    "",
    input.summary.trim(),
    "",
    "## Where it came from",
    "",
    `- Task: ${taskLine} (\`${input.issueId}\`)`,
    `- Discussion room: \`${input.roomId}\``,
    `- Participants: ${participantLine}`,
    `- Tokens: ${input.tokensUsed}, cost: ${costLabel}`,
  ];
  if (input.note?.trim()) {
    lines.push("", "## Note from the owner", "", input.note.trim());
  }
  lines.push(
    "",
    "## Status",
    "",
    "Registered from an agent discussion as a **candidate**: it is not delivered",
    "to any agent until a promotion is approved.",
    "",
  );
  return lines.join("\n");
}

/** The stored settings shape of `general.agentExchangeFeed`. */
export const agentExchangeFeedSettingsSchema = z
  .object({
    feedLimit: z
      .number()
      .int()
      .min(MIN_AGENT_EXCHANGE_FEED_LIMIT)
      .max(MAX_AGENT_EXCHANGE_FEED_LIMIT),
    skillCandidateEnabled: z.boolean(),
  })
  .strict();

export type AgentExchangeFeedSettings = z.infer<typeof agentExchangeFeedSettingsSchema>;

/** Body of `PATCH /api/myrmidon/companies/:companyId/agent-exchange/feed/settings`. */
export const patchAgentExchangeFeedSettingsSchema = agentExchangeFeedSettingsSchema.partial().strict();

export type AgentExchangeFeedSettingsPatch = z.infer<typeof patchAgentExchangeFeedSettingsSchema>;

export const DEFAULT_AGENT_EXCHANGE_FEED_SETTINGS: AgentExchangeFeedSettings = {
  feedLimit: DEFAULT_AGENT_EXCHANGE_FEED_LIMIT,
  skillCandidateEnabled: DEFAULT_AGENT_EXCHANGE_SKILL_CANDIDATE_ENABLED,
};

export interface ResolvedAgentExchangeFeedSettings {
  settings: AgentExchangeFeedSettings;
  sources: Record<AgentExchangeFeedSettingKey, AgentExchangeFeedSettingSource>;
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeAgentExchangeFeedSettings(raw: unknown): AgentExchangeFeedSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = agentExchangeFeedSettingsSchema.safeParse(raw);
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
export function resolveAgentExchangeFeedSettings(input: {
  stored: unknown;
  env?: Record<string, string | undefined>;
}): ResolvedAgentExchangeFeedSettings {
  // The shared package compiles without node types, so the environment is
  // read through globalThis (undefined in the browser — the caller passes env
  // explicitly where it matters).
  const env =
    input.env ??
    ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {});
  const stored = normalizeAgentExchangeFeedSettings(input.stored);

  const settings: AgentExchangeFeedSettings = { ...DEFAULT_AGENT_EXCHANGE_FEED_SETTINGS };
  const sources = {} as Record<AgentExchangeFeedSettingKey, AgentExchangeFeedSettingSource>;
  for (const key of AGENT_EXCHANGE_FEED_SETTING_KEYS) sources[key] = "default";

  if (stored) {
    Object.assign(settings, stored);
    for (const key of AGENT_EXCHANGE_FEED_SETTING_KEYS) sources[key] = "settings";
    return { settings, sources };
  }

  const envLimit = parseEnvInt(
    env[AGENT_EXCHANGE_FEED_ENV_KEYS.feedLimit],
    MIN_AGENT_EXCHANGE_FEED_LIMIT,
    MAX_AGENT_EXCHANGE_FEED_LIMIT,
  );
  if (envLimit !== null) {
    settings.feedLimit = envLimit;
    sources.feedLimit = "env";
  }
  const envCandidate = parseEnvBoolean(env[AGENT_EXCHANGE_FEED_ENV_KEYS.skillCandidateEnabled]);
  if (envCandidate !== null) {
    settings.skillCandidateEnabled = envCandidate;
    sources.skillCandidateEnabled = "env";
  }

  return { settings, sources };
}