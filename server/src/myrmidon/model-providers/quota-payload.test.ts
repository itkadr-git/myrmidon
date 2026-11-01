import { describe, expect, it } from "vitest";
import { latestAccountError, parseResetAfterText } from "./quota-payload.js";

describe("pool quota payload helpers", () => {
  it("parses Google Resets in duration into unix seconds", () => {
    expect(parseResetAfterText("429: Resets in 26 hours", 1_000_000)).toBe(94_600);
    expect(parseResetAfterText("Resets in 30 minutes", 1_000_000)).toBe(1_001_800);
    expect(parseResetAfterText("other error", 1_000_000)).toBeNull();
  });

  it("selects the newest recent error message", () => {
    expect(latestAccountError({ usage: { recent_errors: [
      { at: 100, message: "old" }, { at: 200, message: "latest" },
    ] } })).toBe("latest");
    expect(latestAccountError({ error: "fallback" })).toBe("fallback");
  });
});
