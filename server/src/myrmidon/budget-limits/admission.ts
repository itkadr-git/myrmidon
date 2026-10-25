// server/src/myrmidon/budget-limits/admission.ts
//
// myrmidon(1.7-BUDGET-CONFIG): the hierarchy limits of BUDGET-CONFIG A
// (budget_limits rows) take effect on run admission. Until this module the
// rows were configurable (screen, journal, usage, effective resolver) but
// nothing on the run path read them — only the vendor `budget_policies`
// arms of `getInvocationBlock` did. This closes the epic's "a limit change
// acts in the queue within a minute, no restart" acceptance for the queue
// side: every admission evaluation resolves the effective limit for the
// issue fresh from the database.
//
// Semantics (they intentionally mirror BUDGET-CONFIG-B's enforcement modes):
//  - signal_only (the budget-limits default): never refuse. The overrun is
//    already surfaced by the usage screen; nothing stops.
//  - hard (the limit row's own mode): the run is refused with a reason that
//    names the level and ref the limit came from.
//  - soft (the limit row's own mode): never refuse on the admission path.
//    Soft stops are the incident/pause machinery of B, not admission.
// The mode that decides is the LIMIT ROW's mode; the global signal-only
// flag gates the whole feature off (the corrupt-data-safe default is ON =
// no enforcement, the same direction A chose for the flag).
//
// The function is pure data-in/data-out over already-loaded rows so the
// db-backed tests and the unit tests share one decision core.

import type { EffectiveBudgetLimitView } from "@myrmidon/shared";
import { isBudgetLimitOver } from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";

import { createBudgetLimitStore } from "./store.js";
import { computeBudgetLimitUsage } from "./usage.js";
import { readResolvedSignalOnly, type BudgetLimitsSettingsService } from "./settings.js";
import { createForagingBudgetStatePort } from "./foraging-port.js";

/** A minimal slice of the limit row the over-predicate reads. */
export type BudgetLimitOverPredicate = { amountCents: number; isActive: boolean };

/** What a refusal looks like to the queue (a subset of the vendor block). */
export interface BudgetLimitAdmissionBlock {
  reason: string;
  /** The closest vendor scope, for existing queue diagnostics. */
  scopeType: "agent" | "project" | "company";
  scopeId: string;
  /** The hierarchy level/ref that actually triggered the refusal. */
  scopeRef: string;
  sourceLevel: EffectiveBudgetLimitView["sourceLevel"];
  sourceRef: string | null;
  amountCents: number;
  spentCents: number;
}

export type BudgetLimitAdmissionDecision =
  | { blocked: false }
  | ({ blocked: true } & BudgetLimitAdmissionBlock);

/** Map the effective level to the closest vendor scope the queue reports. */
function scopeOf(
  level: NonNullable<EffectiveBudgetLimitView["sourceLevel"]>,
  ref: string,
  agentId: string,
): { scopeType: BudgetLimitAdmissionBlock["scopeType"]; scopeId: string } {
  // issue/foraging/caste refusals are the agent's own admission: the vendor
  // block has no such scope names, and every consumer that reads scopeType
  // (skip-request diagnostics, cancel paths) handles exactly these three.
  if (level === "issue" || level === "foraging" || level === "caste") {
    return { scopeType: "agent", scopeId: agentId };
  }
  if (level === "nest" && ref === "company") return { scopeType: "company", scopeId: ref };
  return { scopeType: "project", scopeId: ref };
}

function describeRef(
  level: NonNullable<EffectiveBudgetLimitView["sourceLevel"]>,
  ref: string,
): string {
  if (level === "caste") return `caste ${ref}`;
  if (level === "foraging") return "foraging";
  if (level === "issue") return `task ${ref.slice(0, 8)}`;
  if (level === "nest" && ref === "company") return "the company nest";
  return `project nest ${ref.slice(0, 8)}`;
}

/**
 * Decide whether the hierarchy limit refuses this run admission.
 *
 * Inputs are the effective limit (from `resolveEffectiveBudgetLimit` /
 * `store.effective`) and the spend of the period for that same limit
 * (from `computeBudgetLimitUsage` with the limit's own level/ref/period —
 * precedence is enforced by the resolver, the spend is always counted at
 * the source level, never re-derived at a shallower one).
 */
export function decideBudgetLimitAdmission(
  effective: EffectiveBudgetLimitView | null,
  spentCents: number,
  options: { signalOnly: boolean; agentId?: string },
): BudgetLimitAdmissionDecision {
  if (options.signalOnly) return { blocked: false };
  if (!effective) return { blocked: false };
  if (effective.sourceLevel === null || effective.sourceRef === null) return { blocked: false };
  if (effective.amountCents === null || effective.period === null) return { blocked: false };
  // Only hard-mode limit rows refuse admission; soft rows signal elsewhere.
  if (effective.mode !== "hard") return { blocked: false };

  const limit: BudgetLimitOverPredicate = {
    amountCents: effective.amountCents,
    // The effective resolver only returns active rows (inactive ones never
    // become the source), so an effective limit is always an active one.
    isActive: true,
  };
  if (!isBudgetLimitOver(limit, spentCents)) return { blocked: false };

  const { scopeType, scopeId } = scopeOf(
    effective.sourceLevel,
    effective.sourceRef,
    options.agentId ?? effective.sourceRef,
  );
  const source = describeRef(effective.sourceLevel, effective.sourceRef);
  return {
    blocked: true,
    reason: `Budget limit exceeded for ${source}: spent $${(spentCents / 100).toFixed(2)} of the $${(
      effective.amountCents / 100
    ).toFixed(2)} limit for the period (${effective.period === "lifetime" ? "lifetime" : "calendar month"}). New runs are refused until the limit is raised or the period resets.`,
    scopeType,
    scopeId,
    scopeRef: source,
    sourceLevel: effective.sourceLevel,
    sourceRef: effective.sourceRef,
    amountCents: effective.amountCents,
    spentCents,
  };
}

/** Ports of the db-backed admission evaluation (all injectable for tests). */
export interface BudgetLimitAdmissionPorts {
  db: Db;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** Inputs resolved per admission (companyId/agentId come from the queue). */
export interface BudgetLimitAdmissionInput {
  companyId: string;
  agentId: string;
  /** The issue the run would serve — the deepest level of the hierarchy. */
  issueId: string | null;
  /** Fall-back when the issue row has no project (the queue passes both). */
  projectId: string | null;
  /** The instance settings reader for the global signal-only flag. */
  settings: BudgetLimitsSettingsService;
}

/**
 * The db-backed admission check: resolve the effective limit for the issue
 * fresh (every call reads the current rows — the acceptance "no restart"),
 * count the spend of that limit's own period, and decide. No limit, an
 * unknown issue, or signal-only mode → null (never blocks).
 */
export async function evaluateBudgetLimitAdmission(
  ports: BudgetLimitAdmissionPorts,
  input: BudgetLimitAdmissionInput,
): Promise<BudgetLimitAdmissionBlock | null> {
  if (!input.issueId) return null;
  const signalOnly = (await readResolvedSignalOnly(input.settings, ports.env ?? process.env)).signalOnly;
  if (signalOnly) return null;
  const store = createBudgetLimitStore({ db: ports.db, now: ports.now });
  const effective = await store.effective(input.companyId, input.issueId);
  if (!effective || effective.sourceLevel === null || effective.sourceLimitId === null) return null;
  const usage = await computeBudgetLimitUsage(
    { db: ports.db, foragingBudgetState: createForagingBudgetStatePort(ports.db), now: ports.now },
    input.companyId,
    effective.sourceLevel,
    effective.sourceRef ?? "",
    effective.period ?? "calendar_month_utc",
  );
  const decision = decideBudgetLimitAdmission(effective, usage.spentCents, {
    signalOnly: false,
    agentId: input.agentId,
  });
  return decision.blocked
    ? {
        reason: decision.reason,
        scopeType: decision.scopeType,
        scopeId: decision.scopeId,
        scopeRef: decision.scopeRef,
        sourceLevel: decision.sourceLevel,
        sourceRef: decision.sourceRef,
        amountCents: decision.amountCents,
        spentCents: decision.spentCents,
      }
    : null;
}
