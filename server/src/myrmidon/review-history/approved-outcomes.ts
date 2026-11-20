// server/src/myrmidon/review-history/approved-outcomes.ts
//
// myrmidon(1.8 LEARN, OPE-13159): the bounded read/query contract for approved
// review outcomes. query.ts (OPE-12928) validates and redacts records a caller
// already loaded; this module is the narrow SQL boundary that LOADS such
// records from `issue_execution_decisions` in the first place: one read-only
// query, documented filters, a hard pagination cap, and a redaction boundary
// that keeps actor/run/metadata fields on the database side of the contract.
//
// Contract (OPE-13159):
// - company-scoped and read-only: SELECT against `issue_execution_decisions`
//   plus the issue/work-product joins needed for PR coordinates; no mutation,
//   no route mounts, no skill-file writes;
// - filters are exactly: `stageType = "review"`, `outcome = "approved"`,
//   `createdAt` inside the closed 30-day window [now - window, now]. Anything
//   older, newer, non-review, or not approved never leaves the database;
// - pagination is keyset over (createdAt, id) and the page size is capped at
//   `REVIEW_HISTORY_MAX_PAGE_SIZE`: a caller asking for more gets the cap, and
//   the `nextCursor` is absent once the page is exhausted, so a consumer can
//   never page past the window silently;
// - redaction boundary: the returned records carry only feedback text
//   (redacted in place by the same `redactSensitiveText` query.ts uses),
//   timestamp, issue id/identifier, and PR coordinates. Author ids, actor ids,
//   run ids, stage ids, and metadata blobs are never selected for return;
// - the output row is structurally a `ReviewHistorySource` with
//   `kind: "review_decision"`, so the result feeds `extractReviewFeedback`
//   (OPE-12928) directly and the 30-day admissibility check there stays the
//   second, independent gate.

import { and, desc, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  issueExecutionDecisions,
  issues,
  issueWorkProducts,
  type Db,
} from "@myrmidon/db";
import {
  REVIEW_HISTORY_WINDOW_MS,
  redactSensitiveText,
  type ReviewHistorySource,
} from "./query.js";

/**
 * Hard upper bound of one page of approved review outcomes. The learning
 * pipeline consumes bounded input; an uncapped page would let a single tick
 * pull the entire decision history and silently break the 30-day contract by
 * volume. Callers that need more pass the returned cursor.
 */
export const REVIEW_HISTORY_MAX_PAGE_SIZE = 100;

/** Inputs of the bounded approved-outcome query. All fields are optional
 *  except the company scope; defaults fail closed toward the narrowest
 *  useful query. */
export interface ApprovedReviewOutcomeQueryInput {
  /** Company scope — the query never crosses company boundaries. */
  companyId: string;
  /** Reference "now"; defaults to the wall clock. Injectable for tests. */
  now?: Date;
  /** Lookback window; capped at the shared 30-day LEARN window. */
  windowMs?: number;
  /**
   * Requested page size. Values above `REVIEW_HISTORY_MAX_PAGE_SIZE` are
   * clamped to the cap; non-positive or non-finite values fall back to the
   * cap instead of rejecting the query.
   */
  limit?: number;
  /** Keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
}

/** One page of sanitized, approved review outcomes. */
export interface ApprovedReviewOutcomePage {
  /** Sanitized records in `ReviewHistorySource` shape (kind review_decision). */
  records: ReviewHistorySource[];
  /**
   * Opaque keyset cursor for the next page, or `null` when the page is
   * exhausted. Consumers stop paging at `null` — the cursor never points
   * outside the 30-day window.
   */
  nextCursor: string | null;
}

const PULL_REQUEST_URL_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/i;

/** `owner/repo` + number of a pull_request work product: metadata first, URL second. */
function pullRequestCoordinates(
  metadata: Record<string, unknown> | null,
  url: string | null,
): { repository: string; number: number } | null {
  const repo = metadata?.repo ?? metadata?.repository;
  const repository =
    typeof repo === "string" && repo.includes("/") ? repo : null;
  const rawNumber = metadata?.number ?? metadata?.pullRequestNumber;
  const number = typeof rawNumber === "number" && Number.isSafeInteger(rawNumber) && rawNumber > 0 ? rawNumber : null;
  if (repository && number !== null) return { repository, number };
  const match = url ? PULL_REQUEST_URL_PATTERN.exec(url) : null;
  return match ? { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed as unknown[];
    if (typeof iso !== "string" || typeof id !== "string") return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Read one bounded page of approved review outcomes for the learning pipeline.
 *
 * The query is deliberately narrow: only `stageType = "review"` rows with
 * `outcome = "approved"` inside the closed 30-day window are eligible. The
 * returned rows are redacted at this boundary (same `redactSensitiveText` as
 * query.ts) and carry no actor, run, or metadata fields. Ordering is
 * deterministic — (createdAt DESC, id DESC) — so repeated passes over the
 * same history paginate identically.
 */
export async function queryApprovedReviewOutcomes(
  db: Db,
  input: ApprovedReviewOutcomeQueryInput,
): Promise<ApprovedReviewOutcomePage> {
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? REVIEW_HISTORY_WINDOW_MS;
  const requested = input.limit ?? REVIEW_HISTORY_MAX_PAGE_SIZE;
  const limit =
    Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, REVIEW_HISTORY_MAX_PAGE_SIZE)
      : REVIEW_HISTORY_MAX_PAGE_SIZE;

  // Fail closed on a degenerate window or clock: nothing is eligible.
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(now.getTime())) {
    return { records: [], nextCursor: null };
  }

  const since = new Date(now.getTime() - Math.min(windowMs, REVIEW_HISTORY_WINDOW_MS));

  const filters: SQL[] = [
    eq(issueExecutionDecisions.companyId, input.companyId),
    eq(issueExecutionDecisions.stageType, "review"),
    eq(issueExecutionDecisions.outcome, "approved"),
    // Closed window [since, now]: older and future-dated rows stay in the DB.
    gt(issueExecutionDecisions.createdAt, since),
    lt(issueExecutionDecisions.createdAt, now),
  ];

  let cursor: { createdAt: Date; id: string } | null = null;
  if (input.cursor) {
    cursor = decodeCursor(input.cursor);
    // An unparsable cursor fails closed to the first page of the window
    // instead of rejecting the query outright.
  }
  if (cursor) {
    // Keyset: (createdAt, id) strictly before the cursor in DESC order.
    filters.push(
      or(
        lt(issueExecutionDecisions.createdAt, cursor.createdAt),
        and(
          eq(issueExecutionDecisions.createdAt, cursor.createdAt),
          lt(issueExecutionDecisions.id, cursor.id),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      decisionId: issueExecutionDecisions.id,
      body: issueExecutionDecisions.body,
      createdAt: issueExecutionDecisions.createdAt,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      productMetadata: issueWorkProducts.metadata,
      productUrl: issueWorkProducts.url,
    })
    .from(issueExecutionDecisions)
    .innerJoin(issues, eq(issues.id, issueExecutionDecisions.issueId))
    .leftJoin(
      issueWorkProducts,
      and(
        eq(issueWorkProducts.companyId, input.companyId),
        eq(issueWorkProducts.issueId, issues.id),
        eq(issueWorkProducts.type, "pull_request"),
        // Choose one stable work product before paginating decisions.
        sql`${issueWorkProducts.id} = (select p.id from issue_work_products p
          where p.company_id = ${issues.companyId} and p.issue_id = ${issues.id}
            and p.type = 'pull_request'
          order by p.is_primary desc, p.created_at desc, p.id desc limit 1)`,
      ),
    )
    .where(and(...filters, isNull(issues.hiddenAt)))
    .orderBy(desc(issueExecutionDecisions.createdAt), desc(issueExecutionDecisions.id))
    // Fetch one extra row: its presence (beyond `limit`) means there is a next page.
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  const records: ReviewHistorySource[] = [];
  for (const row of pageRows) {
    const coordinates = pullRequestCoordinates(row.productMetadata ?? null, row.productUrl ?? null);
    // A decision we cannot attribute to a pull request or a ticket identifier
    // is not review-history input for the learning pipeline: dropping it here
    // is cheaper than letting it fail the downstream admissibility gate as
    // poison. Volume, not correctness, is what gets lost.
    if (!coordinates) continue;
    if (!row.issueIdentifier?.trim()) continue;
    records.push({
      id: row.decisionId,
      kind: "review_decision",
      createdAt: row.createdAt.toISOString(),
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      pullRequest: coordinates,
      // Redaction boundary: prose crosses only after credential/PII stripping.
      body: redactSensitiveText(row.body),
    });
  }

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.decisionId) : null;

  return { records, nextCursor };
}
