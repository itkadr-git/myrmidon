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
  const sorted = events
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of sorted) {
    if (event.conclusion === "success") since = null;
    else if (["failure", "timed_out", "action_required", "startup_failure"].includes(event.conclusion ?? "")) since ??= event.at;
  }
  return since;
}

export interface ReviewVerdict {
  outcome: "approve" | "return" | "other";
  at: string;
  headSha?: string | null;
}

export interface PrMarkerState {
  hasMarker: boolean;
  markedAt?: string | null;
  markerHeadSha?: string | null;
}

/**
 * Derives the timestamp since an APPROVE review verdict has lacked a valid `review-approved` PR marker.
 * Emits the verdict timestamp when an APPROVE review verdict exists on an open PR but the marker is missing or stale.
 * Returns null when the marker is present and current, or when the PR is merged/closed/not approved.
 */
export function staleMarkerSince(input: {
  verdict: ReviewVerdict | null;
  marker: PrMarkerState;
  prStatus?: string | null;
  currentHeadSha?: string | null;
}): string | null {
  if (!input.verdict || input.verdict.outcome !== "approve") return null;
  if (input.prStatus === "merged" || input.prStatus === "closed") return null;

  const verdictTime = Date.parse(input.verdict.at);
  if (!Number.isFinite(verdictTime)) return null;

  // Head mismatch between review and current PR head: marker on old head is stale
  if (
    input.verdict.headSha &&
    input.currentHeadSha &&
    input.verdict.headSha.toLowerCase() !== input.currentHeadSha.toLowerCase()
  ) {
    return input.verdict.at;
  }

  // Missing marker
  if (!input.marker.hasMarker) {
    return input.verdict.at;
  }

  // Marker was applied before the latest verdict: stale marker
  if (input.marker.markedAt) {
    const markerTime = Date.parse(input.marker.markedAt);
    if (Number.isFinite(markerTime) && markerTime < verdictTime) {
      return input.verdict.at;
    }
  }

  // Marker explicitly tied to a different head sha than current
  if (
    input.marker.markerHeadSha &&
    input.currentHeadSha &&
    input.marker.markerHeadSha.toLowerCase() !== input.currentHeadSha.toLowerCase()
  ) {
    return input.verdict.at;
  }

  return null;
}

/**
 * Derives the timestamp since an approved PR has been waiting for auto-merge.
 * Emits the approval timestamp when a PR is approved and remains open/unmerged.
 * Returns null when merged, closed, or not approved.
 */
export function stalledMergeSince(input: {
  approvedAt: string | null;
  prStatus?: string | null;
  isMerged?: boolean;
}): string | null {
  if (!input.approvedAt) return null;
  if (input.isMerged || input.prStatus === "merged" || input.prStatus === "closed") return null;
  const approvedTime = Date.parse(input.approvedAt);
  if (!Number.isFinite(approvedTime)) return null;
  return input.approvedAt;
}

/**
 * Derives the timestamp since the review router queue has been stalled for an unrouted issue.
 * Emits the entered-review timestamp when an issue is in_review without a reviewer.
 * Returns null when a reviewer is assigned or the issue leaves in_review.
 */
export function stalledRouterSince(input: {
  status: string;
  needsReviewer: boolean;
  inReviewSince: string | null;
}): string | null {
  if (input.status !== "in_review" || !input.needsReviewer) return null;
  if (!input.inReviewSince) return null;
  const time = Date.parse(input.inReviewSince);
  if (!Number.isFinite(time)) return null;
  return input.inReviewSince;
}
