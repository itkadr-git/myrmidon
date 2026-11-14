import { describe, expect, it } from "vitest";
import {
  RUN_MODEL_SELECTION_SNAPSHOT_SCHEMA,
  UNKNOWN_STEP_CLASS,
  readRunModelSelection,
} from "./run-model-selection.js";

describe("readRunModelSelection", () => {
  it("reads reviewer -> strong group snapshot", () => {
    const snapshot = {
      modelSelection: {
        schema: RUN_MODEL_SELECTION_SNAPSHOT_SCHEMA,
        stepClass: "reviewer",
        modelGroup: "strong",
        model: "gpt-5.1",
        ruleSource: "step_importance",
        ruleLabel: "reviewer -> strong",
        resolvedAt: "2026-11-13T00:00:00.000Z",
      },
    };
    expect(readRunModelSelection(snapshot)).toMatchObject({ stepClass: "reviewer", modelGroup: "strong" });
  });

  it("reads background -> economy group snapshot", () => {
    const snapshot = {
      modelSelection: {
        schema: RUN_MODEL_SELECTION_SNAPSHOT_SCHEMA,
        stepClass: "background",
        modelGroup: "economy",
        model: null,
        ruleSource: "step_importance",
        ruleLabel: "background -> economy",
        resolvedAt: null,
      },
    };
    expect(readRunModelSelection(snapshot)).toMatchObject({ stepClass: "background", modelGroup: "economy" });
  });

  it("returns null for legacy snapshots without a model selection", () => {
    expect(readRunModelSelection({ issueId: "i-1" })).toBeNull();
    expect(readRunModelSelection(null)).toBeNull();
    expect(readRunModelSelection({ modelSelection: { stepClass: "reviewer" } })).toBeNull();
    expect(readRunModelSelection({ modelSelection: { modelGroup: "strong" } })).toBeNull();
  });

  it("keeps the unknown step class constant for snapshot-less records", () => {
    expect(UNKNOWN_STEP_CLASS).toBe("unknown");
  });
});
