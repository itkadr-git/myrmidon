// myrmidon(AGENT-LIVENESS-D1, OPE-13024): the instance-wide thresholds of the
// agent-liveness watchdog, stored as `instance_settings.general.agentLiveness`.
//
// The watchdog itself (queue-without-run per role, probe interval/timeout,
// escalation ladder, journal dedup window and retention, exclusion windows)
// is vertical D2/C1; this module owns the stored shape, the defaults and the
// resolution rule, so both halves compile against one contract.
//
// Defaults are the feature-OFF posture: `enabled: false` and the threshold
// numbers the current review-routing sweep already uses (queueThreshold 8;
// see server/src/myrmidon/review-routing/sweep.ts). Until an operator saves
// a value the watchdog must not change any behaviour on `main`.

import { z } from "zod";
import { DEFAULT_REVIEW_ROUTING_QUEUE_THRESHOLD } from "./myrmidon-review-routing.js";

/** The key of the block inside `instance_settings.general`. */
export const AGENT_LIVENESS_SETTINGS_KEY = "agentLiveness" as const;

/**
 * The values in force when nothing is stored. Every threshold is the constant
 * the behaviour modules use today, so the settings layer cannot drift from the
 * code (the consistency test in myrmidon-agent-liveness.test.ts pins this).
 */
export const DEFAULT_AGENT_LIVENESS_SETTINGS: AgentLivenessSettings = {
  // Feature OFF: no watchdog pass runs until an operator switches it on.
  enabled: false,
  engineerQueueThreshold: DEFAULT_REVIEW_ROUTING_QUEUE_THRESHOLD,
  reviewerQueueThreshold: DEFAULT_REVIEW_ROUTING_QUEUE_THRESHOLD,
  leadQueueThreshold: DEFAULT_REVIEW_ROUTING_QUEUE_THRESHOLD,
  probeIntervalSec: 30,
  probeTimeoutSec: 5,
  escalationSteps: 3,
  escalationStepTimeoutSec: 60,
  journalDedupWindowSec: 900,
  journalRetentionDays: 30,
  exclusionWindows: [],
};

const positiveInt = z.number().int().positive();

/**
 * One exclusion window: a human-readable interval the watchdog must stay
 * silent in ("weekdays 09:00-18:00", release freezes). Free-form on purpose —
 * C1 owns the semantics; the settings layer only bounds the string.
 */
const exclusionWindowSchema = z.string().trim().min(1).max(200);

/**
 * What a stored `instance_settings.general.agentLiveness` row may hold. Every
 * key is optional, so a row saved before a key existed still parses and the
 * missing key keeps the default; `.strict()` keeps a typo out of the row.
 */
export const storedAgentLivenessSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    engineerQueueThreshold: positiveInt.optional(),
    reviewerQueueThreshold: positiveInt.optional(),
    leadQueueThreshold: positiveInt.optional(),
    probeIntervalSec: positiveInt.optional(),
    probeTimeoutSec: positiveInt.optional(),
    escalationSteps: positiveInt.optional(),
    escalationStepTimeoutSec: positiveInt.optional(),
    journalDedupWindowSec: positiveInt.optional(),
    journalRetentionDays: positiveInt.optional(),
    exclusionWindows: z.array(exclusionWindowSchema).optional(),
  })
  .strict();

/** The stored shape's patch form: the same object, every key optional. */
export const patchAgentLivenessSettingsSchema = storedAgentLivenessSettingsSchema;

export type AgentLivenessSettingsPatch = z.infer<typeof storedAgentLivenessSettingsSchema>;

/** The canonical, fully resolved shape — what the API reports as effective. */
export const agentLivenessSettingsSchema = z.object({
  enabled: z.boolean(),
  engineerQueueThreshold: positiveInt,
  reviewerQueueThreshold: positiveInt,
  leadQueueThreshold: positiveInt,
  probeIntervalSec: positiveInt,
  probeTimeoutSec: positiveInt,
  escalationSteps: positiveInt,
  escalationStepTimeoutSec: positiveInt,
  journalDedupWindowSec: positiveInt,
  journalRetentionDays: positiveInt,
  exclusionWindows: z.array(exclusionWindowSchema),
}).strict();

export type AgentLivenessSettings = z.infer<typeof agentLivenessSettingsSchema>;

/**
 * Resolve the effective thresholds: every key of the stored row that parses,
 * otherwise the default. An unreadable row keeps the defaults — a hand-edited
 * value must not take the watchdog down, and (feature OFF) must not start it.
 */
export function resolveAgentLivenessSettings(stored?: unknown): AgentLivenessSettings {
  const parsed = storedAgentLivenessSettingsSchema.safeParse(stored ?? {});
  return agentLivenessSettingsSchema.parse({
    ...DEFAULT_AGENT_LIVENESS_SETTINGS,
    ...(parsed.success ? parsed.data : {}),
  });
}
