import { swarmRoleForUnassignedTask } from "@paperclipai/shared/myrmidon-swarm-claim";
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
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
]);

/** Q1's fail-open derived predicate. Do not infer from title or description. */
export function requiresEngineer(input: EngineerRequirementInput): boolean {
  if (input.labels?.some((label) => label.trim().toLowerCase() === NEEDS_ENGINEER_LABEL)) return true;
  if (engineerCasteRequired(input.casteKey, input.projectDefaultCasteKey, input.labels ?? [])) return true;
  if (input.harnessKind === "skill_test") return true;
  if (isCheckoutRequiredPreference(input.executionWorkspacePreference)) return true;
  return false;
}

export function isCheckoutRequiredPreference(value: string | null | undefined): boolean {
  return value != null && WORKSPACE_PREFERENCES.has(value) && CHECKOUT_PREFERENCES.has(value);
}
