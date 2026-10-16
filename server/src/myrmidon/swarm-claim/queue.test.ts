import { describe, expect, it } from "vitest";
import { engineerCasteRequired, unassignedTaskRoutedToRoleByLabels } from "./queue.js";

describe("unassignedTaskRoutedToRoleByLabels", () => {
  it("matches legacy role routing and the default-role fallback", () => {
    expect(unassignedTaskRoutedToRoleByLabels("engineer", ["Role: Engineer"])).toBe(true);
    expect(unassignedTaskRoutedToRoleByLabels("engineer", ["role:qa"])).toBe(false);
    expect(unassignedTaskRoutedToRoleByLabels("engineer", [])).toBe(false);
    expect(unassignedTaskRoutedToRoleByLabels("general", [])).toBe(true);
  });
});

describe("engineerCasteRequired", () => {
  it("honors explicit caste, then project default, then unassigned routing", () => {
    expect(engineerCasteRequired("engineer", "qa", [])).toBe(true);
    expect(engineerCasteRequired("qa", "engineer", [])).toBe(false);
    expect(engineerCasteRequired(null, null, ["role:engineer"])).toBe(true);
    expect(engineerCasteRequired(null, null, ["role:qa"])).toBe(false);
  });
});
