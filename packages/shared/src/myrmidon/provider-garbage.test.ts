import { describe, expect, it } from "vitest";
import {
  classifyProviderGarbageOutcome,
  detectProviderGarbageGroups,
  resolveProviderGarbageSettings,
  DEFAULT_PROVIDER_GARBAGE_SETTINGS,
} from "./provider-garbage.js";

describe("provider-garbage", () => {
  it("resolves settings with env overrides and defaults", () => {
    const settings = resolveProviderGarbageSettings({
      env: {
        MYRMIDON_PROVIDER_GARBAGE_DISTINCT_AGENTS: "3",
        MYRMIDON_PROVIDER_GARBAGE_SIGNATURES: "custom-stub, another stub",
      },
    });
    expect(settings.distinctAgents).toBe(3);
    expect(settings.sameAgentRuns).toBe(DEFAULT_PROVIDER_GARBAGE_SETTINGS.sameAgentRuns);
    expect(settings.signatures).toContain("custom-stub");
    expect(settings.signatures).toContain("another stub");
    expect(settings.signatures).toContain("server overloaded");
  });

  it("classifies known stub signatures and short outcomes", () => {
    const res1 = classifyProviderGarbageOutcome("tạm thời bảo trì để nâng cấp và sẽ bù ngày - token");
    expect(res1.suspect).toBe(true);
    expect(res1.signatureSource).toBe("known_stub_signature");

    const res2 = classifyProviderGarbageOutcome("server overloaded");
    expect(res2.suspect).toBe(true);

    const res3 = classifyProviderGarbageOutcome("This is a very long normal response that exceeds the maximum outcome character length threshold and should never be classified as suspect garbage.");
    expect(res3.suspect).toBe(false);
  });

  it("detects groups of repeated short outcomes across distinct agents", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const runs = [
      { runId: "r1", agentId: "agent-1", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:55:00Z"), outcomeText: "service maintenance" },
      { runId: "r2", agentId: "agent-2", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:56:00Z"), outcomeText: "service maintenance" },
      { runId: "r3", agentId: "agent-3", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:57:00Z"), outcomeText: "service maintenance" },
      { runId: "r4", agentId: "agent-4", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:58:00Z"), outcomeText: "service maintenance" },
      { runId: "r5", agentId: "agent-5", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:59:00Z"), outcomeText: "service maintenance" },
    ];

    const hits = detectProviderGarbageGroups(runs, { distinctAgents: 5, now });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.runCount).toBe(5);
    expect(hits[0]?.agentIds).toHaveLength(5);
  });

  it("does not report a group hit for isolated runs matching a stub signature below the burst threshold", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const singleRun = [
      {
        runId: "r1",
        agentId: "agent-1",
        modelGroup: "nexus-grok",
        finishedAt: new Date("2026-11-08T11:59:00Z"),
        outcomeText: "tạm thời bảo trì để nâng cấp và sẽ bù ngày - token",
      },
    ];

    const hits = detectProviderGarbageGroups(singleRun, { distinctAgents: 5, sameAgentRuns: 5, now });
    expect(hits).toHaveLength(0);
  });

  it("detects groups when same agent runs cross the sameAgentRuns threshold", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const repeatedRuns = [
      { runId: "r1", agentId: "agent-1", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:50:00Z"), outcomeText: "server overloaded" },
      { runId: "r2", agentId: "agent-1", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:52:00Z"), outcomeText: "server overloaded" },
      { runId: "r3", agentId: "agent-1", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:54:00Z"), outcomeText: "server overloaded" },
      { runId: "r4", agentId: "agent-1", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:56:00Z"), outcomeText: "server overloaded" },
      { runId: "r5", agentId: "agent-1", modelGroup: "nexus-grok", finishedAt: new Date("2026-11-08T11:58:00Z"), outcomeText: "server overloaded" },
    ];

    const hits = detectProviderGarbageGroups(repeatedRuns, { distinctAgents: 5, sameAgentRuns: 5, now });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.runCount).toBe(5);
    expect(hits[0]?.knownSignature).toBe(true);
    expect(hits[0]?.signature).toBe("server overloaded");
  });

  it("safely handles non-string and unknown outcome values", () => {
    expect(normalizeProviderGarbageOutcomeText(undefined)).toBe("");
    expect(normalizeProviderGarbageOutcomeText(null)).toBe("");
    expect(normalizeProviderGarbageOutcomeText(123)).toBe("");
    expect(normalizeProviderGarbageOutcomeText({ foo: "bar" })).toBe("");
    expect(normalizeProviderGarbageOutcomeText("  hello   world  ")).toBe("hello world");

    const res = classifyProviderGarbageOutcome({ text: "not a string" });
    expect(res.suspect).toBe(false);
  });
});
