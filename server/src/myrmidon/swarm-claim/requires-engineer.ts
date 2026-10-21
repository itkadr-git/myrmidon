import { engineerCasteRequired } from "./queue.js";

export const NEEDS_ENGINEER_LABEL = "needs-engineer";

export type EngineerRequirementInput = {
  labels?: readonly string[] | null;
  casteKey?: string | null;
  projectDefaultCasteKey?: string | null;
  harnessKind?: string | null;
  executionWorkspacePreference?: string | null;
};

const WORKSPACE_PREFERENCES = new Set([
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default",
]);
const CHECKOUT_PREFERENCES = new Set<string>([
  "operator_branch",
  "reuse_existing",
]);

export function normalizeLabels(labels: unknown): string[] {
  if (Array.isArray(labels)) {
    return labels
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "name" in item && typeof (item as any).name === "string") {
          return (item as any).name;
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof labels === "string") {
    try {
      const parsed = JSON.parse(labels);
      return normalizeLabels(parsed);
    } catch {
      return labels.trim() ? [labels.trim()] : [];
    }
  }
  return [];
}

/** Q1's fail-open derived predicate. Do not infer from title or description. */
export function requiresEngineer(input: EngineerRequirementInput): boolean {
  const labelsList = normalizeLabels(input.labels);
  if (labelsList.some((label) => label.trim().toLowerCase() === NEEDS_ENGINEER_LABEL)) return true;
  if (engineerCasteRequired(input.casteKey, input.projectDefaultCasteKey, labelsList)) return true;
  if (input.harnessKind === "skill_test") return true;
  if (isCheckoutRequiredPreference(input.executionWorkspacePreference)) return true;
  return false;
}

export function isCheckoutRequiredPreference(value: string | null | undefined): boolean {
  return value != null && WORKSPACE_PREFERENCES.has(value) && CHECKOUT_PREFERENCES.has(value);
}
