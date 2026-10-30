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
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  externalId?: string | number | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PrApprovalCommentFact {
  body: string;
  createdAt: Date | string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  authorType?: string | null;
}

export interface ApprovedPrSinceOptions {
  prNumber?: number | null;
  currentHeadSha?: string | null;
  reviewerAgentIds?: string[] | null;
  authorAgentId?: string | null;
  fallbackApprovedAt?: Date | string | null;
}

/**
 * Extracts PR number from multiple sources:
 * metadata.number, metadata.prNumber, metadata.pullRequestNumber, product.externalId, or PR URL.
 */
export function extractPrNumber(product: PrApprovalProductFact): number | null {
  const meta = product.metadata ?? {};
  const candidates = [
    meta.number,
    meta.prNumber,
    meta.pullRequestNumber,
    product.externalId,
  ];
  for (const val of candidates) {
    if (typeof val === "number" && Number.isSafeInteger(val) && val > 0) {
      return val;
    }
    if (typeof val === "string") {
      const match = val.match(/^\s*#?(\d+)\s*$/);
      if (match) {
        const num = Number(match[1]);
        if (Number.isSafeInteger(num) && num > 0) return num;
      }
    }
  }
  if (typeof product.url === "string") {
    const match = product.url.match(/\/pull\/(\d+)/i);
    if (match) {
      const num = Number(match[1]);
      if (Number.isSafeInteger(num) && num > 0) return num;
    }
  }
  return null;
}

/**
 * Determines when an active PR became approved, if it is currently approved and not merged/closed.
 * Reads:
 * 1. Product reviewState / status ("approved") and metadata (reviewApproved, reviewApprovedAt, review-approved label).
 * 2. Issue comments for reviewer verdicts:
 *    - Canonical header: ^APPROVE PR #N [sha]
 *    - Canonical header: ^REQUEST CHANGES [PR #N] [sha]
 *    - Verdict lines: VERDICT #N: APPROVE / CHANGES REQUESTED
 *    - Cyrillic verdict lines: ВЕРДИКТ #N: ОДОБРЕНО / НА ДОРАБОТКУ
 * Evaluates chronological timeline so rework/reset correctly handles the temporal order.
 * Returns the ISO string of the approval time, or null if unapproved, rejected, or merged/closed.
 */
export function approvedPrSince(
  product: PrApprovalProductFact,
  comments: PrApprovalCommentFact[] = [],
  options: ApprovedPrSinceOptions = {},
): string | null {
  if (["merged", "closed"].includes(product.status)) return null;

  const prNumber = options.prNumber ?? extractPrNumber(product);
  const headSha = options.currentHeadSha ??
    (typeof product.metadata?.headSha === "string" ? product.metadata.headSha :
     typeof product.metadata?.sha === "string" ? product.metadata.sha : null);

  const meta = product.metadata ?? {};

  interface TimelineEvent {
    type: "approve" | "reject";
    time: number;
  }
  const events: TimelineEvent[] = [];

  // 1. Initial product state / metadata approval
  let initialApprovedAt: number | null = null;
  if (typeof meta.reviewApprovedAt === "string") {
    const at = Date.parse(meta.reviewApprovedAt);
    if (Number.isFinite(at)) initialApprovedAt = at;
  } else if (
    product.reviewState === "approved" ||
    product.status === "approved" ||
    meta.reviewApproved === true ||
    (Array.isArray(meta.labels) && meta.labels.includes("review-approved"))
  ) {
    // Avoid product.updatedAt because it resets on any metadata write.
    // Use fallbackApprovedAt (e.g. from activityLog or in_review transition) or product.createdAt.
    const fallback = options.fallbackApprovedAt ?? product.createdAt;
    const at = fallback ? new Date(fallback).getTime() : NaN;
    if (Number.isFinite(at)) initialApprovedAt = at;
  }

  if (initialApprovedAt !== null) {
    events.push({ type: "approve", time: initialApprovedAt });
  }

  // 2. Process comments in chronological order
  const sortedComments = comments
    .map((c) => ({
      body: c.body,
      authorAgentId: c.authorAgentId,
      time: c.createdAt instanceof Date ? c.createdAt.getTime() : Date.parse(String(c.createdAt)),
    }))
    .filter((c) => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);

  for (const comment of sortedComments) {
    // If author of comment is the PR author, ignore self-review verdicts
    if (options.authorAgentId && comment.authorAgentId && comment.authorAgentId === options.authorAgentId) {
      continue;
    }
    // If reviewerAgentIds is specified, comment author must be a reviewer
    if (options.reviewerAgentIds && options.reviewerAgentIds.length > 0 && comment.authorAgentId) {
      if (!options.reviewerAgentIds.includes(comment.authorAgentId)) {
        continue;
      }
    }

    const lines = comment.body.split(/\r?\n/);
    let commentVerdict: "approve" | "reject" | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Case 1: Canonical header ^APPROVE PR #N [sha]
      const approveMatch = line.match(/^APPROVE\s+PR\s+#?(\d+)(?:\s+([a-f0-9]{7,40}))?\b/i);
      if (approveMatch) {
        const commentPrNum = Number(approveMatch[1]);
        if (prNumber !== null && commentPrNum !== prNumber) {
          continue;
        }
        const commentSha = approveMatch[2];
        if (headSha && commentSha) {
          const normHead = headSha.toLowerCase();
          const normCommentSha = commentSha.toLowerCase();
          if (!normHead.startsWith(normCommentSha) && !normCommentSha.startsWith(normHead)) {
            // Mismatching SHA on canonical APPROVE PR header: not valid for current head
            continue;
          }
        }
        commentVerdict = "approve";
        break;
      }

      // Case 2: Canonical header ^REQUEST CHANGES [PR #N] [sha]
      const requestChangesMatch = line.match(/^REQUEST\s+CHANGES(?:\s+PR\s+#?(\d+))?(?:\s+([a-f0-9]{7,40}))?\b/i);
      if (requestChangesMatch) {
        const commentPrNum = requestChangesMatch[1] ? Number(requestChangesMatch[1]) : null;
        if (prNumber !== null && commentPrNum !== null && commentPrNum !== prNumber) {
          continue;
        }
        commentVerdict = "reject";
        break;
      }

      // Case 3: Line starting with VERDICT / ВЕРДИКТ:
      const verdictHeaderMatch = line.match(/^(?:VERDICT|ВЕРДИКТ)(?:\s*#?(\d+))?\s*:\s*(.*)$/iu);
      if (verdictHeaderMatch) {
        const commentPrNum = verdictHeaderMatch[1] ? Number(verdictHeaderMatch[1]) : null;
        if (prNumber !== null && commentPrNum !== null && commentPrNum !== prNumber) {
          continue;
        }
        const textAfter = verdictHeaderMatch[2];
        const approves = /(?:^|[^\p{L}\p{N}])(approve|approved|одобрен[оаы]?|одобрить|lgtm)(?:[^\p{L}\p{N}]|$)/iu.test(textAfter);
        const rejects = /(?:^|[^\p{L}\p{N}])(changes|rework|return|refuse|отклон\p{L}*|доработк\p{L}*)(?:[^\p{L}\p{N}]|$)/iu.test(textAfter);
        if (approves && !rejects) {
          commentVerdict = "approve";
          break;
        } else if (rejects && !approves) {
          commentVerdict = "reject";
          break;
        }
      }

      // Case 4: General line containing verdict/вердикт
      if (/(?:^|[^\p{L}\p{N}])(verdict|вердикт)(?:[^\p{L}\p{N}]|$)/iu.test(line)) {
        const prMatch = line.match(/#(\d+)/);
        const commentPrNum = prMatch ? Number(prMatch[1]) : null;
        if (prNumber !== null && commentPrNum !== null && commentPrNum !== prNumber) {
          continue;
        }
        const approves = /(?:^|[^\p{L}\p{N}])(approve|approved|одобрен[оаы]?|одобрить|lgtm)(?:[^\p{L}\p{N}]|$)/iu.test(line);
        const rejects = /(?:^|[^\p{L}\p{N}])(changes|rework|return|refuse|отклон\p{L}*|доработк\p{L}*)(?:[^\p{L}\p{N}]|$)/iu.test(line);
        if (approves && !rejects) {
          commentVerdict = "approve";
          break;
        } else if (rejects && !approves) {
          commentVerdict = "reject";
          break;
        }
      }
    }

    if (commentVerdict === "approve") {
      events.push({ type: "approve", time: comment.time });
    } else if (commentVerdict === "reject") {
      events.push({ type: "reject", time: comment.time });
    }
  }

  // 3. Chronological evaluation
  events.sort((a, b) => a.time - b.time);

  let isApproved = false;
  let approvedSinceTime: number | null = null;

  for (const event of events) {
    if (event.type === "approve") {
      if (!isApproved) {
        isApproved = true;
        approvedSinceTime = event.time;
      }
    } else if (event.type === "reject") {
      isApproved = false;
      approvedSinceTime = null;
    }
  }

  return isApproved && approvedSinceTime !== null
    ? new Date(approvedSinceTime).toISOString()
    : null;
}
