import { describe, expect, it } from "vitest";
import {
  RUNS_QUEUE_SETTING_KEYS,
} from "@paperclipai/shared/myrmidon-runs-queue-settings";
import { applyLiveBehaviorSettings } from "../behavior-settings/live.js";
import {
  livePauseWakeSettings,
  liveWakeDeliverySettings,
  liveRunPipelineSettings,
  liveStrandedSettings,
  liveAutoResumeSettings,
  liveRunStallSettings,
  liveTaskPrSyncSettings,
  liveSwarmSettings,
  liveDbBackupCatchupWindow,
  liveWorkspaceHygieneSettings,
} from "./live.js";

describe("runs-queue-settings live readers", () => {
  it("registers the runs-queue keys in the part A registry", () => {
    expect(RUNS_QUEUE_SETTING_KEYS).toContain("runsQueue.idlePickup.enabled");
    expect(RUNS_QUEUE_SETTING_KEYS).toContain("runsQueue.runStall.thresholdSec");
    expect(RUNS_QUEUE_SETTING_KEYS).toContain("runsQueue.autoResume.backoffMs");
    expect(RUNS_QUEUE_SETTING_KEYS).toContain("runsQueue.workspaceHygiene.mergedCooldownMs");
    expect(RUNS_QUEUE_SETTING_KEYS).toHaveLength(31);
  });

  it("falls back to defaults when nothing is stored and no env is set", () => {
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    expect(livePauseWakeSettings({} as NodeJS.ProcessEnv)).toEqual({
      drainsEnabled: true,
      resumeWakeBatch: 5,
      pauseMs: 0,
    });
    expect(liveWakeDeliverySettings({} as NodeJS.ProcessEnv)).toEqual({
      skipIdleHeartbeats: true,
      pendingInteractionGraceMs: 300_000,
      pendingInteractionReAdmissions: true,
    });
    expect(liveRunPipelineSettings({} as NodeJS.ProcessEnv)).toEqual({
      infraInterruptCodes: ["context_overflow", "provider_outage", "provider_degraded", "model_unavailable"],
      writeLockRequiresLiveRun: true,
      crossIssueInfluenceLimit: 20,
      continuationHistoryLimit: 30,
      staleLeaseGraceMs: 120_000,
      outboxSweepAgeMs: 45_000,
    });
    expect(liveStrandedSettings({} as NodeJS.ProcessEnv)).toEqual({
      autoPolicy: true,
      autoRetriesPerDay: 1,
      settledHoldsBlockExplicitWakes: true,
    });
    expect(liveAutoResumeSettings({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      attempts: 1,
      intervalSec: 30,
      seriesWindowMs: 300_000,
      backoffMs: [60_000, 300_000, 900_000],
    });
    expect(liveRunStallSettings({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      thresholdSec: 1200,
    });
    expect(liveTaskPrSyncSettings({} as NodeJS.ProcessEnv)).toEqual({ enabled: true });
    expect(liveSwarmSettings({} as NodeJS.ProcessEnv)).toEqual({
      supervisorTaskMax: 5,
      pilotBaselineDoc: null,
    });
    expect(liveDbBackupCatchupWindow({} as NodeJS.ProcessEnv)).toBeNull();
    expect(liveWorkspaceHygieneSettings({} as NodeJS.ProcessEnv)).toEqual({
      mergedCooldownMs: 30 * 60 * 1000,
      stuckSignalAfterMs: 24 * 60 * 60 * 1000,
    });
  });

  it("env overrides the stored value", () => {
    applyLiveBehaviorSettings({
      settings: { "runsQueue.runStall.thresholdSec": 900 },
      sources: { "runsQueue.runStall.thresholdSec": "ui" },
    });
    const env = { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "600" } as NodeJS.ProcessEnv;
    expect(liveRunStallSettings(env).thresholdSec).toBe(600);
  });

  it("stored value wins when no env override", () => {
    applyLiveBehaviorSettings({
      settings: { "runsQueue.runStall.thresholdSec": 900 },
      sources: { "runsQueue.runStall.thresholdSec": "ui" },
    });
    expect(liveRunStallSettings({} as NodeJS.ProcessEnv).thresholdSec).toBe(900);
  });

  it("parses comma-separated arrays from env", () => {
    const env = { MYRMIDON_AUTO_RESUME_BACKOFF_MS: "1000, 5000, 15000" } as NodeJS.ProcessEnv;
    expect(liveAutoResumeSettings(env).backoffMs).toEqual([1000, 5000, 15000]);
  });

  it("parses comma-separated strings from env", () => {
    const env = { MYRMIDON_INFRA_INTERRUPT_CODES: "code_a, code_b" } as NodeJS.ProcessEnv;
    expect(liveRunPipelineSettings(env).infraInterruptCodes).toEqual(["code_a", "code_b"]);
  });

  it("returns null for unset optional strings", () => {
    expect(liveDbBackupCatchupWindow({} as NodeJS.ProcessEnv)).toBeNull();
    expect(liveSwarmSettings({} as NodeJS.ProcessEnv).pilotBaselineDoc).toBeNull();
  });

  it("rounds and clamps numeric values", () => {
    const env = { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "90.7" } as NodeJS.ProcessEnv;
    expect(liveRunStallSettings(env).thresholdSec).toBe(91);
    const env2 = { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "10" } as NodeJS.ProcessEnv;
    expect(liveRunStallSettings(env2).thresholdSec).toBe(60);
  });
});
