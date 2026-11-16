// myrmidon(OPE-13942): the shared hourly budget of the GitHub App's review-side traffic.
// Kept apart from github-rate-limit.ts on purpose: that module is imported all over the
// server (health route, every GitHub reader) and must stay free of the database client;
// the client and drizzle are loaded on the first reservation only.
import type { Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";

const REVIEW_BUDGET_KEY = "github-review-request-budget";

type ReviewSource = "review-recovery" | "review-rework" | "board-merge";

/** Review traffic may use this share of the hour; the board-side merge may use more, so it is never starved by it. */
const REVIEW_SHARE = 0.4;
const BOARD_MERGE_SHARE = 0.9;

/** Wrap the actual transport so retries and hosted-CI probes each consume a reservation. */
export function withGitHubReviewBudget(
  db: Db,
  source: ReviewSource,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  installationLimit = 5000,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    if (!await reserveGitHubReviewRequest(db, source, installationLimit)) {
      throw new Error("GitHub review budget exhausted");
    }
    return fetchImpl(url, init);
  };
}

/**
 * Reserve before each request; the review workers share a rolling one-hour cap (40%), the board-side merge a higher one (90%) over the same counter.
 * The row keeps per-minute counters (at most 60 keys), not one entry per request,
 * so a reservation under the advisory lock reads and writes a few hundred bytes.
 */
export async function reserveGitHubReviewRequest(
  db: Db,
  source: ReviewSource,
  installationLimit = 5000,
): Promise<boolean> {
  try {
    const { instanceSettings } = await import("@myrmidon/db");
    const { eq, sql } = await import("drizzle-orm");
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${REVIEW_BUDGET_KEY}, 0))`);
      const clock = await tx.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
      const minute = Number(clock[0]?.minute);
      if (!Number.isFinite(minute)) return false;
      const [row] = await tx.select({ general: instanceSettings.general }).from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, REVIEW_BUDGET_KEY));
      const stored = row?.general.minutes;
      const minutes: Record<string, number> = {};
      let used = 0;
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [key, count] of Object.entries(stored as Record<string, unknown>)) {
          const at = Number(key);
          if (Number.isInteger(at) && at > minute - 60 && at <= minute && typeof count === "number" && count > 0) {
            minutes[key] = count;
            used += count;
          }
        }
      }
      // One counter for all three sources: board-merge spend also uses up the review share.
      const share = source === "board-merge" ? BOARD_MERGE_SHARE : REVIEW_SHARE;
      if (used >= Math.floor(installationLimit * share)) return false;
      minutes[String(minute)] = (minutes[String(minute)] ?? 0) + 1;
      const general = { minutes };
      await tx.insert(instanceSettings).values({ singletonKey: REVIEW_BUDGET_KEY, general })
        .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { general, updatedAt: new Date() } });
      return true;
    });
  } catch (error) {
    logger.warn({ err: error }, "GitHub review budget unavailable; skipping request");
    return false;
  }
}

