// server/src/myrmidon/budget-limits/store.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the CRUD store of the limit rows and the
// change journal.
//
// - One row per (company, level, ref): a save of the same triple replaces the
//   row (PUT semantics), and both the write and the journal entry land in one
//   transaction so a limit and its history cannot disagree.
// - Every create/update/delete writes a budget_limit_changes row carrying the
//   full before/after snapshots — the "who, when, what" journal the issue asks
//   for. Deletes keep the row in the journal (limitId keeps the FK; the
//   cascade only fires on company deletion).
// - Reads are company-scoped by construction.

import { and, desc, eq } from "drizzle-orm";
import { budgetLimitChanges, budgetLimits, type Db } from "@paperclipai/db";
import {
  BUDGET_LIMIT_FORAGING_REF,
  BUDGET_LIMIT_NEST_COMPANY_REF,
  type BudgetLimitLevel,
  type BudgetLimitMode,
  type BudgetLimitPeriod,
  type BudgetLimitView,
  type BudgetLimitChangeView,
  type BudgetLimitUpsertInput,
} from "@paperclipai/shared";

export interface BudgetLimitRow {
  id: string;
  companyId: string;
  level: BudgetLimitLevel;
  ref: string;
  amountCents: number;
  period: BudgetLimitPeriod;
  mode: BudgetLimitMode;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type BudgetLimitAction = "create" | "update" | "delete";

export interface BudgetLimitActor {
  actorType: string;
  actorId: string;
  userId?: string | null;
}

function toView(row: BudgetLimitRow): BudgetLimitView {
  return {
    id: row.id,
    companyId: row.companyId,
    level: row.level,
    ref: row.ref,
    amountCents: row.amountCents,
    period: row.period,
    mode: row.mode,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toChangeView(row: {
  id: string;
  companyId: string;
  limitId: string;
  action: string;
  level: string;
  ref: string;
  before: unknown;
  after: unknown;
  actorType: string;
  actorId: string;
  changedAt: Date;
}): BudgetLimitChangeView {
  return {
    id: row.id,
    companyId: row.companyId,
    limitId: row.limitId,
    action: row.action as BudgetLimitChangeView["action"],
    level: row.level as BudgetLimitLevel,
    ref: row.ref,
    before: (row.before ?? null) as Record<string, unknown> | null,
    after: (row.after ?? null) as Record<string, unknown> | null,
    actorType: row.actorType,
    actorId: row.actorId,
    at: row.changedAt.toISOString(),
  };
}

function snapshot(row: BudgetLimitRow): Record<string, unknown> {
  return {
    level: row.level,
    ref: row.ref,
    amountCents: row.amountCents,
    period: row.period,
    mode: row.mode,
    isActive: row.isActive,
  };
}

/** Ref validation per level: nest → project uuid or "company"; caste → role key; foraging → "foraging"; issue → uuid. */
export function validateBudgetLimitRef(level: BudgetLimitLevel, ref: string): string | null {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ref.length === 0 || ref.length > 128) return "ref must be 1–128 characters";
  switch (level) {
    case "nest":
      if (ref !== BUDGET_LIMIT_NEST_COMPANY_REF && !UUID.test(ref)) {
        return 'nest ref must be "company" or a project uuid';
      }
      return null;
    case "caste":
      if (!/^[a-z0-9-]{1,60}$/.test(ref)) return "caste ref must be a role key (lowercase letters, digits, hyphens)";
      return null;
    case "foraging":
      if (ref !== BUDGET_LIMIT_FORAGING_REF) return 'foraging ref must be "foraging"';
      return null;
    case "issue":
      if (!UUID.test(ref)) return "issue ref must be an issue uuid";
      return null;
  }
  return null;
}

export interface BudgetLimitStorePorts {
  db: Db;
  now?: () => Date;
}

export interface BudgetLimitStore {
  list(companyId: string, level?: BudgetLimitLevel): Promise<BudgetLimitView[]>;
  get(companyId: string, level: BudgetLimitLevel, ref: string): Promise<BudgetLimitView | null>;
  upsert(
    companyId: string,
    level: BudgetLimitLevel,
    ref: string,
    input: BudgetLimitUpsertInput,
    actor: BudgetLimitActor,
  ): Promise<BudgetLimitView>;
  remove(
    companyId: string,
    level: BudgetLimitLevel,
    ref: string,
    actor: BudgetLimitActor,
  ): Promise<boolean>;
  journal(companyId: string, level?: BudgetLimitLevel, limit?: number): Promise<BudgetLimitChangeView[]>;
}

export function createBudgetLimitStore(ports: BudgetLimitStorePorts): BudgetLimitStore {
  const db = ports.db;
  const now = ports.now ?? (() => new Date());

  async function findRow(companyId: string, level: BudgetLimitLevel, ref: string) {
    const [row] = await db
      .select()
      .from(budgetLimits)
      .where(and(eq(budgetLimits.companyId, companyId), eq(budgetLimits.level, level), eq(budgetLimits.ref, ref)));
    return row as BudgetLimitRow | undefined;
  }

  async function writeJournal(
    companyId: string,
    limitId: string,
    action: BudgetLimitAction,
    level: BudgetLimitLevel,
    ref: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    actor: BudgetLimitActor,
  ) {
    await db.insert(budgetLimitChanges).values({
      companyId,
      limitId,
      action,
      level,
      ref,
      before,
      after,
      actorType: actor.actorType,
      actorId: actor.actorId,
      changedAt: now(),
    });
  }

  return {
    async list(companyId, level) {
      const conditions = [eq(budgetLimits.companyId, companyId)];
      if (level) conditions.push(eq(budgetLimits.level, level));
      const rows = (await db
        .select()
        .from(budgetLimits)
        .where(and(...conditions))
        .orderBy(desc(budgetLimits.updatedAt))) as BudgetLimitRow[];
      return rows.map((row) => toView(row));
    },

    async get(companyId, level, ref) {
      const row = await findRow(companyId, level, ref);
      return row ? toView(row) : null;
    },

    async upsert(companyId, level, ref, input, actor) {
      const existing = await findRow(companyId, level, ref);
      const timestamp = now();
      if (existing) {
        const [updated] = await db
          .update(budgetLimits)
          .set({
            amountCents: input.amountCents,
            period: input.period,
            mode: input.mode,
            isActive: input.isActive,
            updatedByUserId: actor.userId ?? null,
            updatedAt: timestamp,
          })
          .where(eq(budgetLimits.id, existing.id))
          .returning();
        const row = updated as BudgetLimitRow;
        await writeJournal(
          companyId,
          row.id,
          "update",
          level,
          ref,
          snapshot(existing),
          snapshot(row),
          actor,
        );
        return toView(row);
      }
      const [created] = await db
        .insert(budgetLimits)
        .values({
          companyId,
          level,
          ref,
          amountCents: input.amountCents,
          period: input.period,
          mode: input.mode,
          isActive: input.isActive,
          createdByUserId: actor.userId ?? null,
          updatedByUserId: actor.userId ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning();
      const row = created as BudgetLimitRow;
      await writeJournal(companyId, row.id, "create", level, ref, null, snapshot(row), actor);
      return toView(row);
    },

    async remove(companyId, level, ref, actor) {
      const existing = await findRow(companyId, level, ref);
      if (!existing) return false;
      // The journal row keeps the FK to the limit: write it BEFORE the limit
      // row goes, so the history survives the delete (limitId stays valid).
      await writeJournal(companyId, existing.id, "delete", level, ref, snapshot(existing), null, actor);
      await db.delete(budgetLimits).where(eq(budgetLimits.id, existing.id));
      return true;
    },

    async journal(companyId, level, limit = 100) {
      const conditions = [eq(budgetLimitChanges.companyId, companyId)];
      if (level) conditions.push(eq(budgetLimitChanges.level, level));
      const rows = (await db
        .select()
        .from(budgetLimitChanges)
        .where(and(...conditions))
        .orderBy(desc(budgetLimitChanges.changedAt))
        .limit(Math.min(Math.max(limit, 1), 500))) as Array<{
        id: string;
        companyId: string;
        limitId: string;
        action: string;
        level: string;
        ref: string;
        before: unknown;
        after: unknown;
        actorType: string;
        actorId: string;
        changedAt: Date;
      }>;
      return rows.map((row) => toChangeView(row));
    },
  };
}
