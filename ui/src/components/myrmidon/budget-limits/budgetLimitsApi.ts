// myrmidon(1.7 BUDGET-CONFIG D): API client of the "Budgets" screen — the spend
// limits per hierarchy level, their change journal and the global "signal only"
// mode. Part A (OPE-4161) owns the server routes; this client speaks the frozen
// contract:
//
//   GET    /api/myrmidon/companies/:companyId/budget-limits
//          -> { limits: BudgetLimitView[] }
//   GET    /api/myrmidon/companies/:companyId/budget-limits/usage
//          -> { usage: BudgetLimitUsageRow[] }
//   GET    /api/myrmidon/companies/:companyId/budget-limits/journal[?level=&limit=]
//          -> { journal: BudgetLimitChangeView[] }
//   GET    /api/myrmidon/companies/:companyId/budget-limits/signal-only
//          -> { signalOnly, source }
//   PATCH  /api/myrmidon/companies/:companyId/budget-limits/signal-only
//          body { signalOnly } -> { signalOnly, source }
//   PUT    /api/myrmidon/companies/:companyId/budget-limits/limits/:level/:ref
//          body { amountCents, period, mode, isActive } -> BudgetLimitView
//   DELETE /api/myrmidon/companies/:companyId/budget-limits/limits/:level/:ref
//          -> { removed: true }
//
// Types live here (not in @paperclipai/shared) while part A is unmerged, so the
// UI touches neither server nor shared files; once A lands, the types move to
// the shared contract and this module keeps only the calls — the same split the
// WIP limit screen uses.
import { api } from "@/api/client";

/** The hierarchy levels a limit can sit on: nest → caste → foraging → task. */
export const BUDGET_LIMIT_LEVELS = ["nest", "caste", "foraging", "issue"] as const;
export type BudgetLimitLevel = (typeof BUDGET_LIMIT_LEVELS)[number];

/** The window a limit is counted over. */
export const BUDGET_LIMIT_PERIODS = ["calendar_month_utc", "lifetime"] as const;
export type BudgetLimitPeriod = (typeof BUDGET_LIMIT_PERIODS)[number];

/** hard — refuse; soft — pause and a card to the owner. */
export const BUDGET_LIMIT_MODES = ["hard", "soft"] as const;
export type BudgetLimitMode = (typeof BUDGET_LIMIT_MODES)[number];

/** The nest ref of the company itself. */
export const BUDGET_LIMIT_NEST_COMPANY_REF = "company";

/** The single foraging ref. */
export const BUDGET_LIMIT_FORAGING_REF = "foraging";

/** One limit row as the API returns it. */
export interface BudgetLimitView {
  id: string;
  companyId: string;
  level: BudgetLimitLevel;
  ref: string;
  amountCents: number;
  period: BudgetLimitPeriod;
  mode: BudgetLimitMode;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A limit row plus its spend in the current period. */
export interface BudgetLimitUsageRow extends BudgetLimitView {
  spentCents: number;
  events: number;
  overLimit: boolean;
}

/** One journal entry: who, when, what. */
export interface BudgetLimitChangeView {
  id: string;
  companyId: string;
  /** Null when the limit row was deleted after this entry (history survives). */
  limitId: string | null;
  action: "create" | "update" | "delete";
  level: BudgetLimitLevel;
  ref: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorType: string;
  actorId: string;
  at: string;
}

/** Where the effective "signal only" value comes from. */
export type BudgetLimitsSignalOnlySource = "default" | "stored" | "env";

export interface BudgetLimitsSignalOnlyView {
  signalOnly: boolean;
  source: BudgetLimitsSignalOnlySource;
}

/** Body of the limit save (PUT). */
export interface BudgetLimitUpsertBody {
  amountCents: number;
  period: BudgetLimitPeriod;
  mode: BudgetLimitMode;
  isActive: boolean;
}

export const budgetLimitsQueryKey = (companyId: string) =>
  ["myrmidon", "budget-limits", "list", companyId] as const;
export const budgetLimitsUsageQueryKey = (companyId: string) =>
  ["myrmidon", "budget-limits", "usage", companyId] as const;
export const budgetLimitsJournalQueryKey = (companyId: string) =>
  ["myrmidon", "budget-limits", "journal", companyId] as const;
export const budgetLimitsSignalOnlyQueryKey = (companyId: string) =>
  ["myrmidon", "budget-limits", "signal-only", companyId] as const;

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/budget-limits`;

const limitPath = (companyId: string, level: BudgetLimitLevel, ref: string) =>
  `${base(companyId)}/limits/${encodeURIComponent(level)}/${encodeURIComponent(ref)}`;

export const budgetLimitsApi = {
  list: async (companyId: string): Promise<BudgetLimitView[]> =>
    (await api.get<{ limits: BudgetLimitView[] }>(base(companyId))).limits,
  usage: async (companyId: string): Promise<BudgetLimitUsageRow[]> =>
    (await api.get<{ usage: BudgetLimitUsageRow[] }>(`${base(companyId)}/usage`)).usage,
  journal: async (companyId: string): Promise<BudgetLimitChangeView[]> =>
    (await api.get<{ journal: BudgetLimitChangeView[] }>(`${base(companyId)}/journal`)).journal,
  getSignalOnly: (companyId: string) =>
    api.get<BudgetLimitsSignalOnlyView>(`${base(companyId)}/signal-only`),
  patchSignalOnly: (companyId: string, signalOnly: boolean) =>
    api.patch<BudgetLimitsSignalOnlyView>(`${base(companyId)}/signal-only`, { signalOnly }),
  saveLimit: (companyId: string, level: BudgetLimitLevel, ref: string, body: BudgetLimitUpsertBody) =>
    api.put<BudgetLimitView>(limitPath(companyId, level, ref), body),
  removeLimit: (companyId: string, level: BudgetLimitLevel, ref: string) =>
    api.delete<{ removed: boolean }>(limitPath(companyId, level, ref)),
};