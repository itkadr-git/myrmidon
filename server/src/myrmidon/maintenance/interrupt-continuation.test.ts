import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_RETRY_CONTINUATION_STATE,
  buildMaintenanceRetryInstruction,
  maintenanceRetryContinuation,
} from "./interrupt-continuation.js";

// myrmidon(OPE-12802, OPE-13077)
describe("maintenance retry continuation", () => {
  it("names the interrupted run and the window and forbids a fresh start in English", () => {
    const text = buildMaintenanceRetryInstruction({ runId: "run-1", windowId: "win-1" });
    expect(text).toContain("run-1");
    expect(text).toContain("win-1");
    expect(text).toContain("Do not start over");
    expect(text).not.toContain("Не начинай заново");
    expect(text).not.toContain("Последнее полезное действие");
  });

  it("reports start, interrupt time and duration when known", () => {
    const text = buildMaintenanceRetryInstruction({
      runId: "r",
      windowId: "w",
      startedAt: "2026-11-12T01:00:00.000Z",
      finishedAt: "2026-11-12T01:17:00.000Z",
    });
    expect(text).toContain("2026-11-12T01:00:00.000Z");
    expect(text).toContain("2026-11-12T01:17:00.000Z");
    expect(text).toContain("17 min");
  });

  it("reports the last useful action when it is known and ignores an invalid date", () => {
    const known = buildMaintenanceRetryInstruction({ runId: "r", windowId: "w", lastUsefulActionAt: "2026-11-12T02:00:00.000Z" });
    expect(known).toContain("2026-11-12T02:00:00.000Z");
    const bad = buildMaintenanceRetryInstruction({ runId: "r", windowId: "w", lastUsefulActionAt: "not a date" });
    expect(bad).not.toContain("Last useful action");
  });

  it("includes branch and head SHA when the board knows them", () => {
    const text = buildMaintenanceRetryInstruction({
      runId: "r",
      windowId: "w",
      headBranch: "bot/OPE-13077",
      headSha: "abc123def456",
    });
    expect(text).toContain("bot/OPE-13077");
    expect(text).toContain("abc123def456");
  });

  it("returns the fields scheduleBoundedRetry copies into the retry context", () => {
    expect(maintenanceRetryContinuation({ runId: "r", windowId: "w" })).toEqual({
      livenessContinuationInstruction: expect.stringContaining("r"),
      livenessContinuationState: MAINTENANCE_RETRY_CONTINUATION_STATE,
    });
  });
});
