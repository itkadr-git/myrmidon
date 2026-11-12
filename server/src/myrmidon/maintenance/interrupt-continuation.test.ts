import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_RETRY_CONTINUATION_STATE,
  buildMaintenanceRetryInstruction,
  maintenanceRetryContinuation,
} from "./interrupt-continuation.js";

// myrmidon(OPE-12802)
describe("maintenance retry continuation", () => {
  it("names the interrupted run and the window and forbids a fresh start", () => {
    const text = buildMaintenanceRetryInstruction({ runId: "run-1", windowId: "win-1" });
    expect(text).toContain("run-1");
    expect(text).toContain("win-1");
    expect(text).toContain("Не начинай заново");
    expect(text).not.toContain("Последнее полезное действие");
  });

  it("reports the last useful action when it is known and ignores an invalid date", () => {
    const known = buildMaintenanceRetryInstruction({ runId: "r", windowId: "w", lastUsefulActionAt: "2026-11-12T02:00:00.000Z" });
    expect(known).toContain("2026-11-12T02:00:00.000Z");
    const bad = buildMaintenanceRetryInstruction({ runId: "r", windowId: "w", lastUsefulActionAt: "not a date" });
    expect(bad).not.toContain("Последнее полезное действие");
  });

  it("returns the fields scheduleBoundedRetry copies into the retry context", () => {
    expect(maintenanceRetryContinuation({ runId: "r", windowId: "w" })).toEqual({
      livenessContinuationInstruction: expect.stringContaining("r"),
      livenessContinuationState: MAINTENANCE_RETRY_CONTINUATION_STATE,
    });
  });
});
