import { describe, expect, it } from "vitest";
import {
  engineerCasteRequired,
  isPoolAuthAlertTitle,
  routedRoleForTask,
  taskRequiresEngineer,
  unassignedTaskRoutedToRoleByLabels,
} from "./queue.js";

describe("unassignedTaskRoutedToRoleByLabels", () => {
  it("matches legacy role routing and the default-role fallback", () => {
    expect(unassignedTaskRoutedToRoleByLabels("engineer", ["Role: Engineer"])).toBe(true);
    expect(unassignedTaskRoutedToRoleByLabels("engineer", ["role:qa"])).toBe(false);
    expect(unassignedTaskRoutedToRoleByLabels("engineer", [])).toBe(false);
    expect(unassignedTaskRoutedToRoleByLabels("general", [])).toBe(true);
  });
});

describe("pool authentication alerts routing (OPE-7707)", () => {
  it("identifies pool login alerts from title", () => {
    expect(isPoolAuthAlertTitle("Google AI Pro sign-in expired (account #3)")).toBe(true);
    expect(isPoolAuthAlertTitle("Antigravity: account acc12 sign in")).toBe(true);
    expect(isPoolAuthAlertTitle("Normal task title")).toBe(false);
    expect(isPoolAuthAlertTitle(null)).toBe(false);
  });

  it("routes pool login alerts to operator and not engineer", () => {
    expect(routedRoleForTask({ title: "Google AI Pro sign-in expired (account #1)" })).toBe("operator");
    expect(routedRoleForTask({ title: "Antigravity: account acc04" })).toBe("operator");
    expect(taskRequiresEngineer({ title: "Google AI Pro sign-in expired (account #1)" })).toBe(false);
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
