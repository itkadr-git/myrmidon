// Budget enforcement mode (myrmidon 1.7 BUDGET-CONFIG-B):
// GET/PATCH /api/myrmidon/budget-enforcement.
//
// What a crossed spend limit does while its incident is open — signal only,
// pause with an owner card, or refuse new runs. PATCH saves it to the
// instance settings and it applies at the next budget evaluation, without
// restarting the server.
import type {
  BudgetEnforcementPatch,
  BudgetEnforcementSource,
  ResolvedBudgetEnforcement,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export type BudgetEnforcementView = ResolvedBudgetEnforcement;

export const budgetEnforcementQueryKey = ["myrmidon", "budget-enforcement"] as const;

export const budgetEnforcementApi = {
  get: () => api.get<BudgetEnforcementView>("/myrmidon/budget-enforcement"),
  update: (patch: BudgetEnforcementPatch) =>
    api.patch<BudgetEnforcementView>("/myrmidon/budget-enforcement", patch),
};

export function describeBudgetEnforcementSource(source: BudgetEnforcementSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Forced by the server environment";
    default:
      return "Default";
  }
}
