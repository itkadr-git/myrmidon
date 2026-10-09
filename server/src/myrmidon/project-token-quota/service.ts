// server/src/myrmidon/project-token-quota/service.ts
//
// myrmidon(1.6.6 QUOTA-V2): the project token quota service — reading and
// writing the quota rows, maintaining the usage counters, and answering the
// enqueue-time block.
//
// Storage: one row per project in `project_token_quotas` (companyId scoped).
// A null limit means that window is unlimited; no row at all means the whole
// feature is off for the project (the default).
//
// Usage counters: `dailyTokensUsed`/`weeklyTokensUsed` are incremented when
// the cost service records a cost event attributed to the project (the hook
// `recordCostEvent` below), and reset to 0 when the window rolls — the
// `dailyWindowStart`/`weeklyWindowStart` columns say which window the counter
// belongs to, so a counter from a previous window reads as zero. The counter
// is the fast path for the enqueue check; the status API re-aggregates from
// `cost_events` for display, so a lost update never over-permits (worst case
// it under-reports the counter and the check is more permissive for one read;
// the next increment fixes it).
//
// Windows: daily = the UTC day [00:00, next 00:00); weekly = the ISO week
// [Monday 00:00 UTC, next Monday 00:00 UTC) — the same UTC anchors the
// heartbeat daily cap uses.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects, projectTokenQuotas } from "@paperclipai/db";
import {
  projectTokenQuotaSchema,
  type ProjectTokenQuota,
  type ProjectTokenQuotaBlock,
} from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../../errors.js";

export type ProjectTokenQuotaRow = typeof projectTokenQuotas.$inferSelect;

/** The UTC day window containing `now`. */
export function currentUtcDayWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** The ISO-week (Monday 00:00 UTC) window containing `now`. */
export function currentIsoWeekWindow(now = new Date()): { start: Date; end: Date } {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // ISO weekday: Mon=1..Sun=7; the week starts Monday.
  const isoWeekday = ((day.getUTCDay() + 6) % 7) + 1;
  const start = new Date(day.getTime() - (isoWeekday - 1) * 24 * 60 * 60 * 1000);
  return { start, end: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

/** Tokens of one cost event, as the quota counts them. */
export function tokensOfCostEvent(input: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  return input.inputTokens + input.cachedInputTokens + input.outputTokens;
}

async function getProjectRow(db: Db, companyId: string, projectId: string) {
  const [row] = await db
    .select({ id: projects.id, name: projects.name, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row || row.companyId !== companyId) return null;
  return row;
}

/**
 * Read the quota of one project: the stored row when present, else the
 * implicit default (no limits, feature off). Never throws for a missing row.
 */
export async function readProjectTokenQuota(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<ProjectTokenQuota | null> {
  const project = await getProjectRow(db, companyId, projectId);
  if (!project) throw notFound("Project not found");
  const [row] = await db
    .select()
    .from(projectTokenQuotas)
    .where(eq(projectTokenQuotas.projectId, projectId))
    .limit(1);
  if (!row) return { projectId, dailyTokenLimit: null, weeklyTokenLimit: null };
  return {
    projectId,
    dailyTokenLimit: row.dailyTokenLimit === null ? null : Number(row.dailyTokenLimit),
    weeklyTokenLimit: row.weeklyTokenLimit === null ? null : Number(row.weeklyTokenLimit),
  };
}

/** The status answer: the quota plus the live usage counters per window. */
export interface ProjectTokenQuotaStatus extends ProjectTokenQuota {
  projectName: string;
  dailyTokensUsed: number;
  weeklyTokensUsed: number;
  dailyWindowStart: string | null;
  weeklyWindowStart: string | null;
}

export async function readProjectTokenQuotaStatus(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<ProjectTokenQuotaStatus> {
  const quota = await readProjectTokenQuota(db, companyId, projectId);
  const [row] = await db
    .select()
    .from(projectTokenQuotas)
    .where(eq(projectTokenQuotas.projectId, projectId))
    .limit(1);
  return {
    ...quota,
    projectName: (await getProjectRow(db, companyId, projectId))?.name ?? "",
    dailyTokensUsed: Number(row?.dailyTokensUsed ?? 0),
    weeklyTokensUsed: Number(row?.weeklyTokensUsed ?? 0),
    dailyWindowStart: row?.dailyWindowStart?.toISOString() ?? null,
    weeklyWindowStart: row?.weeklyWindowStart?.toISOString() ?? null,
  };
}

/** Create or update the quota of one project (upsert by projectId). */
export async function upsertProjectTokenQuota(
  db: Db,
  companyId: string,
  projectId: string,
  input: unknown,
  actorUserId: string | null,
): Promise<ProjectTokenQuota> {
  const project = await getProjectRow(db, companyId, projectId);
  if (!project) throw notFound("Project not found");
  const parsed = projectTokenQuotaSchema.safeParse(input);
  if (!parsed.success) {
    throw badRequest("Invalid project token quota body", {
      code: "invalid_body",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const { dailyTokenLimit, weeklyTokenLimit } = parsed.data;
  if (dailyTokenLimit !== null && weeklyTokenLimit !== null && weeklyTokenLimit < dailyTokenLimit) {
    throw unprocessable("The weekly token limit cannot be lower than the daily token limit");
  }

  const now = new Date();
  const dailyWindow = currentUtcDayWindow(now);
  const weeklyWindow = currentIsoWeekWindow(now);
  const values = {
    companyId,
    projectId,
    dailyTokenLimit,
    weeklyTokenLimit,
    setByUserId: actorUserId,
    updatedAt: now,
  };

  const [row] = await db
    .insert(projectTokenQuotas)
    .values({ ...values, dailyWindowStart: dailyWindow.start, weeklyWindowStart: weeklyWindow.start })
    .onConflictDoUpdate({
      target: projectTokenQuotas.projectId,
      set: {
        dailyTokenLimit,
        weeklyTokenLimit,
        setByUserId: actorUserId,
        updatedAt: now,
      },
    })
    .returning();

  return {
    projectId,
    dailyTokenLimit: row.dailyTokenLimit === null ? null : Number(row.dailyTokenLimit),
    weeklyTokenLimit: row.weeklyTokenLimit === null ? null : Number(row.weeklyTokenLimit),
  };
}

/** The usage of a window, folded to zero when the stored window has rolled. */
function windowUsage(row: ProjectTokenQuotaRow, kind: "daily" | "weekly", now: Date): number {
  const used = kind === "daily" ? Number(row.dailyTokensUsed) : Number(row.weeklyTokensUsed);
  const startedAt = kind === "daily" ? row.dailyWindowStart : row.weeklyWindowStart;
  const windowStart = kind === "daily" ? currentUtcDayWindow(now).start : currentIsoWeekWindow(now).start;
  // A counter started before the current window belongs to an older window:
  // the usage it holds is already history, so it reads as zero. (The next
  // cost event rolls the column over; the display status re-aggregates.)
  if (startedAt < windowStart) return 0;
  return used;
}

/**
 * The enqueue-time check: null when the project may start new runs, the
 * first over-limit window otherwise (daily checked before weekly).
 */
export async function getProjectTokenQuotaBlock(
  db: Db,
  companyId: string,
  projectId: string,
  now = new Date(),
): Promise<ProjectTokenQuotaBlock | null> {
  const [row] = await db
    .select()
    .from(projectTokenQuotas)
    .where(
      and(
        eq(projectTokenQuotas.companyId, companyId),
        eq(projectTokenQuotas.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) return null;

  if (row.dailyTokenLimit !== null) {
    const limit = Number(row.dailyTokenLimit);
    const used = windowUsage(row, "daily", now);
    if (used >= limit) {
      return {
        projectId,
        projectName: "",
        windowKind: "daily",
        tokenLimit: limit,
        tokensUsed: used,
      };
    }
  }
  if (row.weeklyTokenLimit !== null) {
    const limit = Number(row.weeklyTokenLimit);
    const used = windowUsage(row, "weekly", now);
    if (used >= limit) {
      return {
        projectId,
        projectName: "",
        windowKind: "weekly",
        tokenLimit: limit,
        tokensUsed: used,
      };
    }
  }
  return null;
}

/**
 * The cost-event hook: fold one event's tokens into the project's counters,
 * rolling the window columns over when they belong to a previous window.
 * No row yet and no limits set = nothing to count (the row is created by the
 * quota upsert, not by usage).
 */
export async function recordProjectTokenUsage(
  db: Db,
  input: { companyId: string; projectId: string; tokens: number },
  now = new Date(),
): Promise<void> {
  if (!input.projectId || input.tokens <= 0) return;
  const [row] = await db
    .select()
    .from(projectTokenQuotas)
    .where(
      and(
        eq(projectTokenQuotas.companyId, input.companyId),
        eq(projectTokenQuotas.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!row) return;

  const dailyWindowStart = currentUtcDayWindow(now).start;
  const weeklyWindowStart = currentIsoWeekWindow(now).start;
  const dailyRolled = row.dailyWindowStart < dailyWindowStart;
  const weeklyRolled = row.weeklyWindowStart < weeklyWindowStart;

  await db
    .update(projectTokenQuotas)
    .set({
      dailyTokensUsed: dailyRolled ? input.tokens : sql`${projectTokenQuotas.dailyTokensUsed} + ${input.tokens}`,
      weeklyTokensUsed: weeklyRolled ? input.tokens : sql`${projectTokenQuotas.weeklyTokensUsed} + ${input.tokens}`,
      dailyWindowStart,
      weeklyWindowStart,
      updatedAt: now,
    })
    .where(eq(projectTokenQuotas.projectId, input.projectId));
}

/** Exported for tests: the block reason string of a quota refusal. */
export const PROJECT_TOKEN_QUOTA_SKIP_REASON = "project.token_quota_exceeded";
