import { describe, expect, it } from "vitest";
import { assertValidRoles, KnowledgeDomainError } from "./domain.js";

describe("rule role grammar and stable deduplication", () => {
  it.each(["a", "a".repeat(60), "1lead", "team-lead", "team_lead", "*"])(
    "accepts role %s exactly",
    (role) => {
      expect(assertValidRoles([role])).toEqual([role]);
    },
  );

  it.each([
    ["61 characters", "a".repeat(61)],
    ["leading dash", "-lead"],
    ["leading underscore", "_lead"],
    ["empty", ""],
    ["uppercase", "Lead"],
    ["space", "team lead"],
    ["slash", "team/lead"],
    ["Unicode", "\u043a\u0430\u0441\u0442\u0430"],
  ])("rejects %s with invalid_metadata/400", (_label, role) => {
    let caught: unknown;
    try {
      assertValidRoles(["engineer", role]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeDomainError);
    expect(caught).toMatchObject({ code: "invalid_metadata", status: 400 });
  });

  it("deduplicates frozen input in first-seen order, including wildcard", () => {
    const roles = Object.freeze(["engineer", "*", "engineer", "lead", "*"]);
    expect(assertValidRoles(roles)).toEqual(["engineer", "*", "lead"]);
    expect(roles).toEqual(["engineer", "*", "engineer", "lead", "*"]);

    const reversed = Object.freeze([...roles].reverse());
    expect(assertValidRoles(reversed)).toEqual(["*", "lead", "engineer"]);
    expect(reversed).toEqual(["*", "lead", "engineer", "*", "engineer"]);
  });

  it("returns a new empty array for frozen empty input", () => {
    const roles: readonly string[] = Object.freeze([]);
    const result = assertValidRoles(roles);
    expect(result).toEqual([]);
    expect(result).not.toBe(roles);
  });
});
