import { z } from "zod";

/** Instance-wide thresholds for the agent-liveness watchdog (D1). */
export const AGENT_LIVENESS_SETTINGS_KEY = "agentLiveness" as const;

export const DEFAULT_AGENT_LIVENESS_SETTINGS = {
  enabled: false,
  engineerQueueThreshold: 8,
  reviewerQueueThreshold: 8,
  leadQueueThreshold: 8,
  probeIntervalSec: 60,
  probeTimeoutSec: 30,
  escalationSteps: 3,
  escalationStepTimeoutSec: 60,
  journalDedupWindowSec: 300,
  exclusionWindows: [] as string[],
  journalRetentionDays: 30,
} as const;

const positiveInt = z.number().int().positive();
const exclusionWindow = z.string().trim().min(1).max(200);

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
  exclusionWindows: z.array(exclusionWindow),
  journalRetentionDays: positiveInt,
}).strict();

/** Stored settings are partial so old instance rows remain readable. */
export const storedAgentLivenessSettingsSchema = agentLivenessSettingsSchema.partial().strict();
export const patchAgentLivenessSettingsSchema = storedAgentLivenessSettingsSchema;
export type AgentLivenessSettings = z.infer<typeof agentLivenessSettingsSchema>;
export type AgentLivenessSettingsPatch = z.infer<typeof patchAgentLivenessSettingsSchema>;

export function resolveAgentLivenessSettings(stored?: unknown): AgentLivenessSettings {
  const parsed = storedAgentLivenessSettingsSchema.safeParse(stored ?? {});
  return agentLivenessSettingsSchema.parse({
    ...DEFAULT_AGENT_LIVENESS_SETTINGS,
    ...(parsed.success ? parsed.data : {}),
  });
}
