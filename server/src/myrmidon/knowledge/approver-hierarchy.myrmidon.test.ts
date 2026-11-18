import { describe, expect, it } from "vitest";
import { approverKindSatisfies } from "./domain.js";

describe("approverKindSatisfies", () => {
  it.each([
    ["operator", "operator", true],
    ["operator", "admin", true],
    ["operator", "owner", true],
    ["admin", "operator", false],
    ["admin", "admin", true],
    ["admin", "owner", true],
    ["owner", "operator", false],
    ["owner", "admin", false],
    ["owner", "owner", true],
  ])("required %s, presented %s => %s", (required, presented, expected) => {
    expect(approverKindSatisfies(required, presented)).toBe(expected);
  });

  it.each([
    ["operator", null], ["operator", undefined],
    ["admin", null], ["admin", undefined],
    ["owner", null], ["owner", undefined],
    [null, "operator"], [null, "admin"], [null, "owner"],
    [null, null], [null, undefined],
  ])("rejects missing required or presented authority (%s, %s)", (required, presented) => {
    expect(approverKindSatisfies(required, presented)).toBe(false);
  });

  it.each([
    ["custom-authority", "custom-authority", true],
    ["custom-authority", "other-authority", false],
    ["custom-authority", "Custom-authority", false],
    ["custom-authority", " custom-authority", false],
    ["custom-authority", "custom-authority ", false],
    [" custom-authority", "custom-authority", false],
    ["custom-authority", "operator", false],
    ["custom-authority", "admin", false],
    ["custom-authority", "owner", false],
    ["operator", "custom-authority", false],
    ["admin", "custom-authority", false],
    ["owner", "custom-authority", false],
  ])("compares custom authorities exactly (%s, %s) => %s", (required, presented, expected) => {
    expect(approverKindSatisfies(required, presented)).toBe(expected);
  });
});
