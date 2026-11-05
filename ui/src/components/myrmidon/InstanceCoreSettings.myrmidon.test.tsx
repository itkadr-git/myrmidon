// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { validSharedMountPath } from "./SharedMountSettingsPanel";
import { parseRunPriorityNumber } from "./RunPrioritySettingsPanel";
import { isValidOptimizerAgent } from "./PromptBudgetSettingsPanel";

describe("instance core settings validation", () => {
  it("allows an empty shared-mount path for the volume-root default", () => {
    expect(validSharedMountPath("")).toBe(true);
    expect(validSharedMountPath("/srv/bot-shared")).toBe(true);
  });

  it.each([
    "/",
    "relative",
    "/srv/../etc",
    "/srv/./secret",
    "/srv//shared",
    "/srv/shared/",
    "/srv:shared",
    "/srv,shared",
    "/srv\\shared",
    "/srv\nshared",
  ])("rejects unsafe shared-mount source %s", (path) => {
    expect(validSharedMountPath(path)).toBe(false);
  });

  it("accepts only bounded queue priority integers", () => {
    expect(parseRunPriorityNumber(" 239 ", 239)).toBe(239);
    for (const invalid of ["", "-1", "1.5", "240", "Infinity", "1e2", "9007199254740993"]) {
      expect(parseRunPriorityNumber(invalid, 239)).toBeNull();
    }
  });

  it("validates optimizer agent selection against company agents", () => {
    const agents = [{ id: "agent-1" }, { id: "agent-2" }];
    expect(isValidOptimizerAgent("", agents)).toBe(true);
    expect(isValidOptimizerAgent("agent-1", agents)).toBe(true);
    expect(isValidOptimizerAgent("agent-foreign", agents)).toBe(false);
  });
});
