import { describe, expect, it } from "vitest";
import { buildSessionGenerationsPatch, toSessionGenerationsDraft } from "./SessionGenerationsSettingsPanel";

describe("session generations settings panel", () => {
  it("seeds the draft from the plan's defaults when nothing is stored", () => {
    expect(toSessionGenerationsDraft(undefined)).toEqual({ enabled: true, maxMessages: "400", maxDays: "14" });
  });

  it("seeds the draft from a stored row, including an explicit off", () => {
    expect(toSessionGenerationsDraft({ enabled: false, maxMessages: 50 })).toEqual({
      enabled: false,
      maxMessages: "50",
      maxDays: "14",
    });
  });

  it("builds the full stored shape", () => {
    expect(buildSessionGenerationsPatch({ enabled: false, maxMessages: " 100 ", maxDays: "7" }).patch).toEqual({
      enabled: false,
      maxMessages: 100,
      maxDays: 7,
    });
  });

  it("rejects an empty, fractional, zero or oversized threshold", () => {
    for (const bad of ["", "1.5", "0", "-3", "abc", "1000001"]) {
      const built = buildSessionGenerationsPatch({ enabled: true, maxMessages: bad, maxDays: "14" });
      expect(built.patch).toBeNull();
      expect(built.errors.maxMessages).not.toBeNull();
      expect(built.errors.maxDays).toBeNull();
    }
  });
});
