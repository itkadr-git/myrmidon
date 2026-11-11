import { describe, expect, it } from "vitest";
import {
  classifyProviderGarbageOutcome,
  detectProviderGarbageGroups,
  normalizeProviderGarbageOutcomeText,
  resolveProviderGarbageSettings,
} from "@myrmidon/shared";
import {
  providerGarbageBurstKey,
  providerGarbageBurstKeyFromPayload,
} from "./heartbeat-provider-garbage.js";

const now = new Date("2026-11-08T12:00:00Z");

// myrmidon(PROVIDER-GARBAGE / OPE-12286 review 2): these tests pin the
// finalized-run burst path of heartbeat.ts — the mapping from persisted run
// rows (any status) to detector inputs, and the (outcome, modelGroup, window)
// deduplication of run.provider_garbage.detected events.

describe("provider garbage burst path (heartbeat finalized runs)", () => {
  it("counts unknown short outcomes from succeeded runs as burst hits", () => {
    // Simulated finalized run rows — the stub finalized succeeded (HTTP 200,
    // no known signature), exactly the OPE-12286 gap: detectProviderGarbageGroups
    // must see them regardless of run status, because the detector input is
    // outcome text, not the run status.
    const recentRuns = [
      {
        id: "r1",
        agentId: "agent-1",
        finishedAt: new Date("2026-11-08T11:55:00Z"),
        error: null,
        resultJson: {
          summary: "under maintenance, tokens will be refunded",
          providerModelGroup: "nexus-grok-4.7",
        },
      },
      {
        id: "r2",
        agentId: "agent-2",
        finishedAt: new Date("2026-11-08T11:56:00Z"),
        error: null,
        resultJson: {
          summary: "under maintenance, tokens will be refunded",
          providerModelGroup: "nexus-grok-4.7",
        },
      },
      {
        id: "r3",
        agentId: "agent-3",
        finishedAt: new Date("2026-11-08T11:57:00Z"),
        error: null,
        resultJson: {
          summary: "under maintenance, tokens will be refunded",
          providerModelGroup: "nexus-grok-4.7",
        },
      },
      {
        id: "r4",
        agentId: "agent-4",
        finishedAt: new Date("2026-11-08T11:58:00Z"),
        error: null,
        resultJson: {
          summary: "under maintenance, tokens will be refunded",
          providerModelGroup: "nexus-grok-4.7",
        },
      },
      {
        id: "r5",
        agentId: "agent-5",
        finishedAt: new Date("2026-11-08T11:59:00Z"),
        error: null,
        resultJson: {
          summary: "under maintenance, tokens will be refunded",
          providerModelGroup: "nexus-grok-4.7",
        },
      },
    ];
    const settings = resolveProviderGarbageSettings({ env: {} });
    const hits = detectProviderGarbageGroups(
      recentRuns.map((recent) => {
        const recentResultJson = recent.resultJson;
        const summaryVal = recentResultJson.summary;
        const outcomeCandidate =
          typeof summaryVal === "string"
            ? summaryVal
            : typeof recent.error === "string"
              ? recent.error
              : null;
        return {
          runId: recent.id,
          agentId: recent.agentId,
          modelGroup: recentResultJson.providerModelGroup ?? null,
          finishedAt: recent.finishedAt,
          outcomeText: normalizeProviderGarbageOutcomeText(outcomeCandidate),
        };
      }),
      {
        windowMs: settings.windowMs,
        distinctAgents: settings.distinctAgents,
        sameAgentRuns: settings.sameAgentRuns,
        maxOutcomeChars: settings.maxOutcomeChars,
        signatures: settings.signatures,
      },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.agentIds).toHaveLength(5);
    expect(hits[0]?.modelGroup).toBe("nexus-grok-4.7");
    expect(hits[0]?.knownSignature).toBe(false);
    expect(hits[0]?.signatureSource).toBe("repeated_outcome");
  });

  it("extracts the actual model group, not the light/strong tier", () => {
    // The run row carries providerModelGroup (adapter model / configured
    // model); agents.modelTier never enters the detector input.
    const resultJson = {
      summary: "server overloaded",
      providerModelGroup: "nexus-grok-4.7",
    };
    expect(resultJson.providerModelGroup).toBe("nexus-grok-4.7");
    expect(resultJson.providerModelGroup).not.toBe("light");
    expect(resultJson.providerModelGroup).not.toBe("strong");
    // The classification of the same text still matches the known signature.
    const garbage = classifyProviderGarbageOutcome(
      resultJson.summary,
      resolveProviderGarbageSettings({ env: {} }),
    );
    expect(garbage.suspect).toBe(true);
    expect(garbage.signature).toBe("server overloaded");
  });

  it("deduplicates one P1 event per (outcome, model group) burst window", () => {
    const eventPayload = {
      outcomeText: "tạm thời bảo trì để nâng cấp và sẽ bù ngày - token",
      outcomeNormalized:
        "tạm thời bảo trì để nâng cấp và sẽ bù ngày - token",
      modelGroup: "nexus-grok-4.7",
    };
    const reportedKey =
      providerGarbageBurstKeyFromPayload(eventPayload);
    expect(reportedKey).not.toBeNull();

    // A later finalized run finds the same burst again — it must be skipped
    // because the (outcome, modelGroup) burst was already reported.
    const hitKey = providerGarbageBurstKey(
      "Tạm thời bảo trì để nâng cấp và sẽ bù ngày - TOKEN",
      "nexus-grok-4.7",
    );
    expect(hitKey).toBe(reportedKey);
    expect(reportedKey?.includes("\u0000")).toBe(true);

    // A different model group or a different outcome is a new burst.
    expect(
      providerGarbageBurstKey(
        "tạm thời bảo trì để nâng cấp và sẽ bù ngày - token",
        "other-channel",
      ),
    ).not.toBe(reportedKey);
    expect(
      providerGarbageBurstKey("server overloaded", "nexus-grok-4.7"),
    ).not.toBe(reportedKey);

    // A payload without a normalized outcome cannot produce a key.
    expect(providerGarbageBurstKeyFromPayload({ modelGroup: "x" })).toBeNull();
    expect(providerGarbageBurstKeyFromPayload(null)).toBeNull();
  });

  it("detection stays enabled when MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS=0", () => {
    // The burst detector reads window thresholds from the same settings, and
    // a zero retry budget must not blank them (docs: 0 = no retries only).
    const settings = resolveProviderGarbageSettings({
      env: { MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS: "0" },
    });
    expect(settings.retryMaxAttempts).toBe(0);
    const runs = ["a1", "a2", "a3", "a4", "a5"].map((agentId, index) => ({
      runId: `r-${index}`,
      agentId,
      modelGroup: "nexus-grok-4.7",
      finishedAt: new Date(`2026-11-08T11:5${index}:00Z`),
      outcomeText: "under maintenance, tokens will be refunded",
    }));
    const hits = detectProviderGarbageGroups(runs, {
      windowMs: settings.windowMs,
      distinctAgents: settings.distinctAgents,
      sameAgentRuns: settings.sameAgentRuns,
      maxOutcomeChars: settings.maxOutcomeChars,
      signatures: settings.signatures,
      now,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.modelGroup).toBe("nexus-grok-4.7");
  });
});
