import { evaluateDevflowThresholds, type DevflowMetric } from "./thresholds.js";

export interface DevflowSample {
  companyId: string;
  subjectId: string;
  subjectKind: "agent" | "issue";
  title: string;
  metric: DevflowMetric;
  since: string;
}
export interface DevflowSignal extends DevflowSample {
  durationMs: number;
  dedupKey: string;
}

export function buildDevflowSignals(samples: DevflowSample[], settings: unknown, now: Date): DevflowSignal[] {
  return samples.flatMap((sample) => {
    const since = Date.parse(sample.since);
    if (!Number.isFinite(since) || since > now.getTime()) return [];
    const durationMs = now.getTime() - since;
    return evaluateDevflowThresholds({ [sample.metric]: durationMs }, settings)
      .map(() => ({ ...sample, durationMs, dedupKey: `devflow:${sample.companyId}:${sample.metric}:${sample.subjectId}` }));
  });
}

/** Red means an actual failed completion, not a cancelled/skipped/pending run. */
export function redCiSince(events: { conclusion: string | null; at: string }[]): string | null {
  let since: string | null = null;
  const sorted = events.filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of sorted) {
    if (event.conclusion === "success") since = null;
    else if (["failure", "timed_out", "action_required", "startup_failure"].includes(event.conclusion ?? "")) since ??= event.at;
  }
  return since;
}

export interface PrApprovalProductFact {
  status: string;
  reviewState?: string | null;
  updatedAt?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PrApprovalCommentFact {
  body: string;
  createdAt: Date | string;
}

/**
 * Determines when an active PR became approved, if it is currently approved and not merged/closed.
 * Reads:
 * 1. Product reviewState / status ("approved") and metadata (reviewApproved, reviewApprovedAt, review-approved label).
 * 2. Issue comments for reviewer verdicts (e.g. VERDICT #N: APPROVE / VERDICT: APPROVE).
 * Returns the ISO string of the approval time, or null if unapproved, rejected, or merged/closed.
 */
export function approvedPrSince(
  product: PrApprovalProductFact,
  comments: PrApprovalCommentFact[] = [],
): string | null {
  if (["merged", "closed"].includes(product.status)) return null;

  const meta = product.metadata ?? {};
  const rawNumber = meta.number ?? meta.pullRequestNumber;
  const number = typeof rawNumber === "number" && Number.isSafeInteger(rawNumber) && rawNumber > 0 ? rawNumber : null;

  let productApprovedAt: number | null = null;
  if (product.reviewState === "approved" || product.status === "approved") {
    const at = product.updatedAt ? new Date(product.updatedAt).getTime() : NaN;
    if (Number.isFinite(at)) productApprovedAt = at;
  }
  if (typeof meta.reviewApprovedAt === "string") {
    const at = Date.parse(meta.reviewApprovedAt);
    if (Number.isFinite(at)) productApprovedAt = at;
  } else if (
    meta.reviewApproved === true ||
    (Array.isArray(meta.labels) && meta.labels.includes("review-approved"))
  ) {
    const at = product.updatedAt ? new Date(product.updatedAt).getTime() : NaN;
    if (Number.isFinite(at)) productApprovedAt ??= at;
  }

  let commentApprovedAt: number | null = null;
  let commentRejected = false;

  const sortedComments = comments
    .map((c) => ({ body: c.body, time: c.createdAt instanceof Date ? c.createdAt.getTime() : Date.parse(String(c.createdAt)) }))
    .filter((c) => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);

  for (const comment of sortedComments) {
    const lines = comment.body.split(/\r?\n/);
    for (const line of lines) {
      if (!/\b(verdict|вердикт)\b/i.test(line)) continue;
      const prMatch = line.match(/#(\d+)/);
      const prNum = prMatch ? Number(prMatch[1]) : null;
      if (number !== null && prNum !== null && prNum !== number) {
        continue;
      }
      const approves = /\b(approve|approved|одобрен[оаы]?|одобрить|lgtm)\b/i.test(line);
      const rejects = /\b(changes|rework|return|refuse|отклон|доработк)\b/i.test(line);
      if (approves && !rejects) {
        commentApprovedAt = comment.time;
        commentRejected = false;
      } else if (rejects && !approves) {
        commentApprovedAt = null;
        commentRejected = true;
      }
    }
  }

  if (commentRejected) return null;
  const approvedTime = commentApprovedAt ?? productApprovedAt;
  return approvedTime !== null ? new Date(approvedTime).toISOString() : null;
}
