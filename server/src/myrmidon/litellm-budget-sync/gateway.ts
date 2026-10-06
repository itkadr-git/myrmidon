// server/src/myrmidon/litellm-budget-sync/gateway.ts
//
// myrmidon(1.7-BUDGET-CONFIG-C): the LiteLLM budget-management port.
//
// The gateway is changed WITHOUT a restart through its REST API (the ticket's
// BUD1 dependency): `/key/update` writes per-key budget fields, and the
// `/budget/*` endpoints manage tag budgets. This module is the client
// surface the sync service talks to — the same shape createGatewayKeyAdminPort
// uses (transport with the ADMIN key; tests pass a fake).
//
// What the port keeps:
//  - Only the ADMIN key ever authenticates these calls; agent keys never
//    manage budgets.
//  - No key VALUE travels here — budgets are addressed by alias/tag, which
//    is public data (the M2-B secret name and the myrm-* tag).

/** The budget-management surface of the gateway the projection uses. */
export interface LitellmBudgetGatewayPort {
  /**
   * Reads the effective budget of one gateway key (by its alias, the M2-B
   * secret name): the monthly USD ceiling and the window. `null` fields mean
   * "no budget set" for that part.
   */
  readKeyBudget(input: { alias: string }): Promise<{
    maxBudgetUsd: number | null;
    budgetResetAt: string | null;
    budgetDurationHours: number | null;
  } | null>;

  /**
   * Writes the budget fields of one gateway key (by alias). A `null`
   * maxBudgetUsd REMOVES the budget (LiteLLM treats an explicit null as
   * "no budget"); `soft` limits never fail a call, they only signal.
   */
  writeKeyBudget(input: {
    alias: string;
    maxBudgetUsd: number | null;
    budgetDurationHours: number | null;
    soft: boolean;
  }): Promise<void>;

  /**
   * Reads the budget row of one tag; null when the tag has no budget.
   */
  readTagBudget(input: { tag: string }): Promise<{
    maxBudgetUsd: number | null;
    softBudgetUsd: number | null;
    budgetDurationHours: number | null;
  } | null>;

  /**
   * Creates or updates the budget of one tag. `maxBudgetUsd: null` removes
   * the budget. The tag is the stable `myrm-<level>-<scope>` name.
   */
  upsertTagBudget(input: {
    tag: string;
    maxBudgetUsd: number | null;
    softBudgetUsd: number | null;
    budgetDurationHours: number | null;
  }): Promise<void>;
}

/** One /budget/update-style POST helper (transport shared by all methods). */
async function post(
  baseUrl: string,
  adminKey: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`LLM gateway ${path} answered ${response.status}`);
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * The real port over the gateway REST API:
 *  - key budgets: `/key/info` reads (by alias), `/key/update` writes;
 *  - tag budgets: `/budget/info` reads, `/budget/update` upserts.
 */
export function createLitellmBudgetGatewayPort(baseUrl: string, adminKey: string): LitellmBudgetGatewayPort {
  return {
    async readKeyBudget({ alias }) {
      const body = await post(baseUrl, adminKey, "/key/info", { key_alias: alias });
      const key = body?.key;
      if (typeof key !== "object" || key === null) return null;
      const row = key as Record<string, unknown>;
      return {
        maxBudgetUsd: asNumber(row.max_budget),
        budgetResetAt: asString(row.budget_reset_at),
        budgetDurationHours: asNumber(row.budget_duration),
      };
    },

    async writeKeyBudget({ alias, maxBudgetUsd, budgetDurationHours, soft }) {
      const payload: Record<string, unknown> = { key_alias: alias };
      if (maxBudgetUsd === null) {
        payload.max_budget = null;
      } else {
        payload.max_budget = maxBudgetUsd;
        payload.budget_duration = budgetDurationHours ?? "30d";
        // myrmidon(1.7-BUDGET-CONFIG-C): soft mode never fails the call —
        // LiteLLM signals instead (the board pauses in soft mode).
        if (soft) payload.budget_mode = "soft";
      }
      await post(baseUrl, adminKey, "/key/update", payload);
    },

    async readTagBudget({ tag }) {
      const body = await post(baseUrl, adminKey, "/budget/info", { budget_id: tag });
      const row = (body?.budget_info ?? body) as Record<string, unknown> | null;
      if (typeof row !== "object" || row === null) return null;
      return {
        maxBudgetUsd: asNumber(row.max_budget),
        softBudgetUsd: asNumber(row.soft_budget),
        budgetDurationHours: asNumber(row.budget_duration_hours),
      };
    },

    async upsertTagBudget({ tag, maxBudgetUsd, softBudgetUsd, budgetDurationHours }) {
      const payload: Record<string, unknown> = {
        budget_id: tag,
        max_budget: maxBudgetUsd,
        soft_budget: softBudgetUsd,
        budget_duration: budgetDurationHours === null ? null : `${budgetDurationHours}h`,
      };
      await post(baseUrl, adminKey, "/budget/update", payload);
    },
  };
}
