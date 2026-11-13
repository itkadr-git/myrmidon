import { describe, expect, it } from "vitest";
import {
  agentRecoveryJournalDedupKey,
  isWithinAgentRecoveryExclusionWindow,
} from "./myrmidon-agent-recovery-journal.js";

describe("agent recovery journal contract", () => {
  it("builds a stable dedup key", () => {
    expect(agentRecoveryJournalDedupKey({
      agentId: "agent-1",
      step: "retry",
      cause: "stalled_run",
      window: "2026-11-13T00",
    })).toBe("agent-recovery:agent-1:retry:stalled_run:2026-11-13T00");
  });

  it("suppresses a step inside a supplied exclusion window", () => {
    expect(isWithinAgentRecoveryExclusionWindow(
      new Date("2026-11-13T10:30:00.000Z"),
      [{ startAt: "2026-11-13T10:00:00.000Z", endAt: "2026-11-13T11:00:00.000Z" }],
    )).toBe(true);
    expect(isWithinAgentRecoveryExclusionWindow(
      new Date("2026-11-13T11:00:00.000Z"),
      [{ startAt: "2026-11-13T10:00:00.000Z", endAt: "2026-11-13T11:00:00.000Z" }],
    )).toBe(false);
  });
});
