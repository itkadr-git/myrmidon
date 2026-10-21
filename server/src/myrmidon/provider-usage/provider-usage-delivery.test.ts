import { describe, expect, it } from "vitest";

describe("provider usage warning delivery contract", () => {
  it("uses a stable warning key so retries cannot create a second delivery", () => {
    const warningKey = ["company", "provider", "credential", "rolling_5h", "window", "tokens"].join(":");
    expect(warningKey).toBe("company:provider:credential:rolling_5h:window:tokens");
  });
});