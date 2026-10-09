// packages/shared/src/myrmidon-scent.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): task/agent scent — the one-time classification
// of a task (caste probabilities, tags, Jev complexity questions) and of an
// agent (tags from `agents.capabilities`, model tier), plus the pure matching
// score T1's matcher calls to pick one free agent of a caste for a task.
//
// The classifier itself lives server-side (server/src/myrmidon/scent/); this
// file holds ONLY what both sides must agree on: the stored shapes
// (`IssueScent`, agent scent fields), the scoring function and the
// `general.swarm.scent` settings schema. No I/O and NO process env here —
// this package also runs in the browser (TS2591); the server resolves env
// overrides itself and passes them in via `readScentSettings(swarm, env)`.

import { z } from "zod";
import { DEFAULT_PHEROMONE_STRENGTH_BY_PRIORITY } from "./myrmidon-swarm-claim.js";

// --- stored shapes (design.md §2.4, §7.1 п.4a) --------------------------------

/** The three Jev complexity questions, each a probability in [0,1]. */
export const issueScentComplexitySchema = z.object({
  coordination: z.number().min(0).max(1),
  uncertainty: z.number().min(0).max(1),
  consequences: z.number().min(0).max(1),
});
export type IssueScentComplexity = z.infer<typeof issueScentComplexitySchema>;

/**
 * `issues.scent` jsonb. `casteProbs` keys are caste keys of the company
 * directory (`agent_castes.key`) with a probability each; `tags` is at most
 * `ISSUE_SCENT_MAX_TAGS` short lowercase tags. A task created without a
 * description (or when the classifier is down) keeps `scent = NULL` — the
 * matching score of an unscented task is 0 for every agent by construction.
 */
export const ISSUE_SCENT_MAX_TAGS = 8;

export const issueScentSchema = z.object({
  tags: z.array(z.string().min(1)).max(ISSUE_SCENT_MAX_TAGS),
  casteProbs: z.record(z.string(), z.number().min(0).max(1)),
  complexity: issueScentComplexitySchema,
});
export type IssueScent = z.infer<typeof issueScentSchema>;

/** `issues.caste_source` values (design §2.1, §7.1 п.4a). */
export const ISSUE_CASTE_SOURCES = ["manual", "project", "auto", "default"] as const;
export type IssueCasteSource = (typeof ISSUE_CASTE_SOURCES)[number];

/** `agents.model_tier` / `agent_castes.model_tier` values. */
export const AGENT_MODEL_TIERS = ["light", "strong"] as const;
export type AgentModelTier = (typeof AGENT_MODEL_TIERS)[number];

// --- settings: `general.swarm.scent` ------------------------------------------

export const SCENT_SETTINGS_KEY = "scent";
// `readScentSettings` expects the value of the whole `swarm` section, so the
// section key is a named constant for callers that slice it out of `general`.
export const SWARM_SETTINGS_KEY = "swarm";

export const DEFAULT_SCENT_TAG_WEIGHT = 10;
export const DEFAULT_SCENT_TIER_FIT = 20;
export const DEFAULT_SCENT_SERIOUS_THRESHOLD = 0.4;
export const DEFAULT_SCENT_CONSEQUENCES_BONUS = 10;
export const DEFAULT_SCENT_CONSEQUENCES_BONUS_THRESHOLD = 0.65;
export const DEFAULT_SCENT_CLASSIFIER_TIMEOUT_SEC = 20;
export const DEFAULT_SCENT_CLASSIFIER_MAX_PER_RECORD_PER_HOUR = 1;
export const DEFAULT_SCENT_CLASSIFIER_BATCH_SIZE = 20;
/** The LiteLLM alias the classifier calls when nothing is configured. */
export const DEFAULT_SCENT_CLASSIFIER_MODEL = "qwen-turbo-free";

/**
 * The stored shape of `general.swarm.scent`. Weights tune `scentScore`
 * without a restart; `model` is the LiteLLM gateway alias of the cheap
 * classifier model (DashScope first, z.ai fallback — the alias maps that out
 * gateway-side); `enabled=false` turns classification off entirely (issue
 * creation never calls the gateway, the queue stays parked).
 */
export const scentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  tagWeight: z.number().int().min(0).max(1000).default(DEFAULT_SCENT_TAG_WEIGHT),
  tierFit: z.number().int().min(0).max(1000).default(DEFAULT_SCENT_TIER_FIT),
  seriousThreshold: z.number().min(0).max(1).default(DEFAULT_SCENT_SERIOUS_THRESHOLD),
  consequencesBonus: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(DEFAULT_SCENT_CONSEQUENCES_BONUS),
  consequencesBonusThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_SCENT_CONSEQUENCES_BONUS_THRESHOLD),
  model: z.string().min(1).default(DEFAULT_SCENT_CLASSIFIER_MODEL),
  classifierTimeoutSec: z
    .number()
    .int()
    .min(1)
    .max(120)
    .default(DEFAULT_SCENT_CLASSIFIER_TIMEOUT_SEC),
  classifierMaxPerRecordPerHour: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_SCENT_CLASSIFIER_MAX_PER_RECORD_PER_HOUR),
  classifierBatchSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_SCENT_CLASSIFIER_BATCH_SIZE),
});
export type ScentSettings = z.infer<typeof scentSettingsSchema>;

/**
 * Read `general.swarm.scent` (absent/invalid → module defaults). The env
 * master switch `MYRMIDON_SWARM_SCENT_ENABLED` is resolved by the SERVER and
 * passed in via `env` (this package must not touch `process.env` — it also
 * runs in the browser); an explicit stored value wins over the env, env wins
 * over the default.
 */
export const MYRMIDON_SWARM_SCENT_ENABLED_ENV = "MYRMIDON_SWARM_SCENT_ENABLED";

export function readScentSettings(
  swarm: unknown,
  env?: Record<string, string | undefined>,
): ScentSettings {
  const raw =
    swarm && typeof swarm === "object" && !Array.isArray(swarm)
      ? (swarm as Record<string, unknown>)[SCENT_SETTINGS_KEY]
      : undefined;
  const parsed = scentSettingsSchema.safeParse(raw ?? {});
  const base = parsed.success ? parsed.data : scentSettingsSchema.parse({});
  if (!env) return base;
  const envEnabled = parseOnOff(env[MYRMIDON_SWARM_SCENT_ENABLED_ENV]);
  return { ...base, enabled: envEnabled ?? base.enabled };
}

function parseOnOff(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

// --- scoring ------------------------------------------------------------------

/** What the score needs to know about a task. */
export interface ScentTask {
  scent: IssueScent | null;
}

/** What the score needs to know about an agent. */
export interface ScentAgent {
  id: string;
  scentTags: string[];
  /** Effective tier (the caller resolves caste default → agent override). */
  modelTier: AgentModelTier;
}

export type ScentWeights = Pick<ScentSettings, "tagWeight" | "tierFit" | "seriousThreshold">;

export const DEFAULT_SCENT_WEIGHTS: ScentWeights = {
  tagWeight: DEFAULT_SCENT_TAG_WEIGHT,
  tierFit: DEFAULT_SCENT_TIER_FIT,
  seriousThreshold: DEFAULT_SCENT_SERIOUS_THRESHOLD,
};

/**
 * `scentScore(task, agent, weights)` (design §2.4): one point of
 * `tagWeight` per shared tag, plus `tierFit` when a serious task
 * (`consequences ≥ seriousThreshold`) meets a `strong` agent — and the same
 * amount AGAINST a serious task on a `light` agent. A task without scent
 * scores 0 everywhere (§2.4: «счёт запаха 0 у всех»). The 1.7 reputation
 * multiplier slots in here later as an extra factor.
 */
export function scentScore(
  task: ScentTask,
  agent: ScentAgent,
  weights: ScentWeights = DEFAULT_SCENT_WEIGHTS,
): number {
  if (!task.scent) return 0;
  const agentTags = new Set(agent.scentTags);
  let score = 0;
  for (const tag of task.scent.tags) {
    if (agentTags.has(tag)) score += weights.tagWeight;
  }
  const serious = task.scent.complexity.consequences >= weights.seriousThreshold;
  if (serious) {
    score += agent.modelTier === "strong" ? weights.tierFit : -weights.tierFit;
  }
  return score;
}

/**
 * `pickAgentForTask(task, candidates)` — T1's matcher contract: the agent
 * with the highest score wins; a full tie resolves deterministically to the
 * smaller agent id (design §3.4 п.3). Returns null for an empty candidate
 * list. Until the matcher ships, this is the whole selection rule.
 */
export function pickAgentForTask<T extends ScentAgent>(
  task: ScentTask,
  candidates: readonly T[],
  weights: ScentWeights = DEFAULT_SCENT_WEIGHTS,
): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scentScore(task, candidate, weights);
    if (
      best === null ||
      score > bestScore ||
      (score === bestScore && candidate.id < best.id)
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// --- task strength from scent (design §2.4 п.3) --------------------------------

// One source of truth: the priority → strength baseline is F-27's
// DEFAULT_PHEROMONE_STRENGTH_BY_PRIORITY (myrmidon-swarm-claim.ts). Re-exports
// keep the scent call sites readable without duplicating the mapping.
export const PRIORITY_BASE_STRENGTH: Record<string, number> =
  DEFAULT_PHEROMONE_STRENGTH_BY_PRIORITY;

/**
 * The pheromone strength of a task that was created without an explicit one:
 * base from `priority` plus `consequencesBonus` when the task is really
 * consequential (`consequences ≥ consequencesBonusThreshold`, Jev's 0.65).
 * Without a scent there is no bonus — the priority default stands alone.
 */
export function scentTaskStrength(
  priority: string,
  scent: IssueScent | null,
  settings: Pick<ScentSettings, "consequencesBonus" | "consequencesBonusThreshold"> = {
    consequencesBonus: DEFAULT_SCENT_CONSEQUENCES_BONUS,
    consequencesBonusThreshold: DEFAULT_SCENT_CONSEQUENCES_BONUS_THRESHOLD,
  },
): number {
  const base = PRIORITY_BASE_STRENGTH[priority] ?? PRIORITY_BASE_STRENGTH.medium!;
  if (scent && scent.complexity.consequences >= settings.consequencesBonusThreshold) {
    return base + settings.consequencesBonus;
  }
  return base;
}

/** The caste with the highest probability in a scent; null on an empty map. */
export function scentTopCaste(scent: IssueScent | null): { key: string; p: number } | null {
  if (!scent) return null;
  let top: { key: string; p: number } | null = null;
  for (const [key, p] of Object.entries(scent.casteProbs)) {
    if (!top || p > top.p || (p === top.p && key < top.key)) top = { key, p };
  }
  return top;
}

/** The top caste KEY when its probability clears `minP`, else null (design §2.4 п.2 gate). */
export function topScentCasteKey(scent: IssueScent | null, minP = 0.5): string | null {
  const top = scentTopCaste(scent);
  return top && top.p >= minP ? top.key : null;
}

/** Full defaults of `general.swarm.scent` (settings panel + tests). */
export const DEFAULT_SCENT_SETTINGS: ScentSettings = scentSettingsSchema.parse({});

/** The plain priority-mapped strength (no scent bonus) — the F-27 default. */
export function defaultStrengthForPriority(priority: string): number {
  return PRIORITY_BASE_STRENGTH[priority] ?? PRIORITY_BASE_STRENGTH.medium!;
}
