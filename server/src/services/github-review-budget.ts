// myrmidon(OPE-13942): the shared hourly budget of the GitHub App's review-side traffic.
// Kept apart from github-rate-limit.ts on purpose: that module is imported all over the
// server (health route, every GitHub reader) and must stay free of the database client;
// the client and drizzle are loaded on the first reservation only.
import type { Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";

type ReviewSource = "review-recovery" | "review-rework" | "board-merge";

/** Review traffic may use this share of the hour; the board-side merge may use more, so it is never starved by it. */
const REVIEW_SHARE = 0.4;
const BOARD_MERGE_SHARE = 0.9;

export type ReviewBudgetSnapshot = { used: number; cap: number; windowMinutes: number };
type ReservationResult = { status: "reserved" | "budget_exhausted"; budget: ReviewBudgetSnapshot } | { status: "budget_store_unavailable" };

export class GitHubReviewBudgetError extends Error {
  constructor(readonly reason: "budget_exhausted" | "budget_store_unavailable", readonly budget?: ReviewBudgetSnapshot) {
    super(reason === "budget_exhausted" ? "GitHub review budget exhausted" : "GitHub review budget unavailable");
    this.name = "GitHubReviewBudgetError";
  }
}

/** Wrap the actual transport so retries and hosted-CI probes each consume a reservation. */
export function withGitHubReviewBudget(
  db: Db,
  source: ReviewSource,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  installationLimit = 5000,
  onReservation?: (budget: ReviewBudgetSnapshot) => void,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const reservation = await reserveGitHubReviewRequestResult(db, source, installationLimit);
    if ("budget" in reservation) {
      try { onReservation?.(reservation.budget); } catch { /* Diagnostics must not affect transport. */ }
    }
    if (reservation.status !== "reserved") throw new GitHubReviewBudgetError(reservation.status, "budget" in reservation ? reservation.budget : undefined);
    return fetchImpl(url, init);
  };
}

const COUNTER_PREFIX = "github-budget:";
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;

/** The table is per company (NOT NULL FK); the App's budget is per installation, so the board's first company carries it. */
let budgetCompanyId: string | null = null;

/** Test hook: the carrier is the first company seen, which suites may delete between tests. */
export function resetGitHubReviewBudgetForTests(): void {
  budgetCompanyId = null;
}

/**
 * Reserve before each request; the review workers share a rolling one-hour cap (40%), the board-side
 * merge a higher one (90%), over one counter.
 *
 * Storage: the shared `tool_gateway_rate_limit_counters` table, one row per source and minute
 * (`github-budget:<source>:<minute>`), written with insert ... on conflict do update on the table's
 * unique (company_id, counter_key, window_start_at) index. The check "sum of the hour < cap" and the
 * increment must be one step, so both run under a transaction advisory lock; the rows are tiny
 * (at most 3 x 60 live ones) and `instance_settings` is not touched.
 */
export async function reserveGitHubReviewRequest(
  db: Db,
  source: ReviewSource,
  installationLimit = 5000,
): Promise<boolean> {
  return (await reserveGitHubReviewRequestResult(db, source, installationLimit)).status === "reserved";
}

async function reserveGitHubReviewRequestResult(
  db: Db,
  source: ReviewSource,
  installationLimit: number,
): Promise<ReservationResult> {
  try {
    const { companies, toolGatewayRateLimitCounters: counters } = await import("@myrmidon/db");
    const { and, asc, eq, gt, like, lt, sql } = await import("drizzle-orm");
    if (!budgetCompanyId) {
      const [company] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
      if (!company) return { status: "budget_store_unavailable" };
      budgetCompanyId = company.id;
    }
    const companyId = budgetCompanyId;
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"github-review-request-budget"}, 0))`);
      const clock = await tx.execute(sql`select floor(extract(epoch from clock_timestamp()) * 1000 / ${MINUTE_MS})::bigint as minute`);
      const minute = Number(clock[0]?.minute);
      if (!Number.isFinite(minute)) return { status: "budget_store_unavailable" };
      const windowStart = new Date(minute * MINUTE_MS);
      const horizon = new Date((minute - HOUR_MINUTES + 1) * MINUTE_MS);
      const [{ used } = { used: 0 }] = await tx.select({ used: sql<number>`coalesce(sum(${counters.count}), 0)::int` }).from(counters)
        .where(and(eq(counters.companyId, companyId), like(counters.counterKey, `${COUNTER_PREFIX}%`), gt(counters.windowStartAt, new Date(horizon.getTime() - 1))));
      const cap = Math.floor(installationLimit * (source === "board-merge" ? BOARD_MERGE_SHARE : REVIEW_SHARE));
      const budget = { used, cap, windowMinutes: HOUR_MINUTES };
      if (used >= cap) return { status: "budget_exhausted", budget };
      const inserted = await tx.insert(counters).values({
        companyId,
        counterKey: `${COUNTER_PREFIX}${source}:${minute}`,
        windowStartAt: windowStart,
        windowMs: MINUTE_MS,
        limit: cap,
        count: 1,
        resetAt: new Date(windowStart.getTime() + HOUR_MINUTES * MINUTE_MS),
      }).onConflictDoUpdate({
        target: [counters.companyId, counters.counterKey, counters.windowStartAt],
        set: { count: sql`${counters.count} + 1`, limit: cap, updatedAt: new Date() },
      }).returning({ count: counters.count });
      // First reservation of a minute: drop this budget's rows that left the hour.
      if (inserted[0]?.count === 1) {
        await tx.delete(counters).where(and(
          eq(counters.companyId, companyId),
          like(counters.counterKey, `${COUNTER_PREFIX}%`),
          lt(counters.windowStartAt, horizon),
        ));
      }
      return { status: "reserved", budget: { ...budget, used: used + 1 } };
    });
  } catch {
    logger.warn("GitHub review budget unavailable; skipping request");
    return { status: "budget_store_unavailable" };
  }
}
