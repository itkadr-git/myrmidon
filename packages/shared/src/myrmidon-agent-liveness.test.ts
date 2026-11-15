import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_LIVENESS_SETTINGS,
  AGENT_LIVENESS_BASELINE,
  agentLivenessSettingsSchema,
  patchAgentLivenessSettingsSchema,
  resolveAgentLivenessSettings,
  storedAgentLivenessSettingsSchema,
  AGENT_LIVENESS_SETTINGS_KEY,
  type AgentLivenessSettings,
  type AgentLivenessSettingsPatch,
} from "./myrmidon-agent-liveness.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";
import type { InstanceGeneralSettings } from "./types/instance.js";

describe("agent liveness defaults", () => {
  it("resolve to the feature-OFF defaults when nothing is stored, without touching a DB", () => {
    expect(resolveAgentLivenessSettings()).toEqual(DEFAULT_AGENT_LIVENESS_SETTINGS);
    expect(resolveAgentLivenessSettings(undefined)).toEqual(DEFAULT_AGENT_LIVENESS_SETTINGS);
    expect(resolveAgentLivenessSettings(null)).toEqual(DEFAULT_AGENT_LIVENESS_SETTINGS);
    expect(resolveAgentLivenessSettings({})).toEqual(DEFAULT_AGENT_LIVENESS_SETTINGS);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.engineerQueueThreshold).toBe(AGENT_LIVENESS_BASELINE.queueThreshold);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.reviewerQueueThreshold).toBe(AGENT_LIVENESS_BASELINE.queueThreshold);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.leadQueueThreshold).toBe(AGENT_LIVENESS_BASELINE.queueThreshold);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.probeIntervalSec).toBe(AGENT_LIVENESS_BASELINE.probeIntervalSec);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.probeTimeoutSec).toBe(AGENT_LIVENESS_BASELINE.probeTimeoutSec);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.escalationSteps).toBe(AGENT_LIVENESS_BASELINE.escalationSteps);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.escalationStepTimeoutSec).toBe(AGENT_LIVENESS_BASELINE.escalationStepTimeoutSec);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.journalDedupWindowSec).toBe(AGENT_LIVENESS_BASELINE.journalDedupWindowSec);
    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.journalRetentionDays).toBe(AGENT_LIVENESS_BASELINE.journalRetentionDays);

    expect(DEFAULT_AGENT_LIVENESS_SETTINGS.exclusionWindows).toEqual([]);
  });

  it("rejects zero and negative thresholds — a corrupt value keeps the default", () => {
    for (const key of [
      "engineerQueueThreshold",
      "reviewerQueueThreshold",
      "leadQueueThreshold",
      "probeIntervalSec",
      "probeTimeoutSec",
      "escalationSteps",
      "escalationStepTimeoutSec",
      "journalDedupWindowSec",
      "journalRetentionDays",
    ] as const) {
      expect(storedAgentLivenessSettingsSchema.safeParse({ [key]: 0 }).success).toBe(false);
      expect(storedAgentLivenessSettingsSchema.safeParse({ [key]: -1 }).success).toBe(false);
      expect(storedAgentLivenessSettingsSchema.safeParse({ [key]: 1.5 }).success).toBe(false);
    }
    // A stored row that cannot parse resolves to the defaults, not an error.
    expect(resolveAgentLivenessSettings({ probeIntervalSec: 0 })).toEqual(DEFAULT_AGENT_LIVENESS_SETTINGS);
  });

  it("rejects unknown keys and non-string exclusion windows", () => {
    expect(storedAgentLivenessSettingsSchema.safeParse({ nope: true }).success).toBe(false);
    expect(
      storedAgentLivenessSettingsSchema.safeParse({ exclusionWindows: [42] }).success,
    ).toBe(false);
    expect(
      storedAgentLivenessSettingsSchema.safeParse({ exclusionWindows: ["release freeze"] }).success,
    ).toBe(true);
  });

  it("applies a stored patch onto the defaults", () => {
    const resolved = resolveAgentLivenessSettings({
      enabled: true,
      engineerQueueThreshold: 12,
      probeIntervalSec: 90,
      exclusionWindows: ["weekdays 09:00-18:00"],
    });
    expect(resolved).toMatchObject({
      enabled: true,
      engineerQueueThreshold: 12,
      probeIntervalSec: 90,
      exclusionWindows: ["weekdays 09:00-18:00"],
    });
    // Keys the patch does not carry stay at the defaults.
    expect(resolved.reviewerQueueThreshold).toBe(AGENT_LIVENESS_BASELINE.queueThreshold);
    expect(resolved.journalRetentionDays).toBe(AGENT_LIVENESS_BASELINE.journalRetentionDays);
    expect(resolved.probeTimeoutSec).toBe(AGENT_LIVENESS_BASELINE.probeTimeoutSec);
    expect(resolved.journalDedupWindowSec).toBe(AGENT_LIVENESS_BASELINE.journalDedupWindowSec);
  });

  it("is a field of the instance general settings, in step with its interface", () => {
    const parsed = instanceGeneralSettingsSchema.safeParse({
      agentLiveness: { enabled: true, engineerQueueThreshold: 5 },
    });
    expect(parsed.success).toBe(true);
    // Compile-time guard: the hand-written interface and the validator must
    // agree on agentLiveness, or this assignment stops type-checking.
    const view: InstanceGeneralSettings = parsed.success ? parsed.data : ({} as InstanceGeneralSettings);
    const typed: AgentLivenessSettingsPatch | undefined = view.agentLiveness;
    expect(typed?.enabled).toBe(true);
    expect(typed?.engineerQueueThreshold).toBe(5);
    expect(instanceGeneralSettingsSchema.safeParse({}).success).toBe(true);
    expect(patchAgentLivenessSettingsSchema.safeParse({ engineerQueueThreshold: -3 }).success).toBe(false);
    expect(AGENT_LIVENESS_SETTINGS_KEY).toBe("agentLiveness");
  });

  it("keeps the resolved shape strict against the schema", () => {
    const resolved = resolveAgentLivenessSettings({ enabled: true });
    expect(agentLivenessSettingsSchema.safeParse(resolved).success).toBe(true);
    expect(
      agentLivenessSettingsSchema.safeParse({ ...resolved, unknown: 1 }).success,
    ).toBe(false);
  });
});
