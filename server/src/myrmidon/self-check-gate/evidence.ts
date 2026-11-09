/**
 * myrmidon(OPE-12145, epic OPE-12136 block 1.7): the evidence reader of the
 * pre-`in_review` stop-gate.
 *
 * The stop-gate (OPE-12144, `domain.ts`) judges pure facts; this module is the
 * only place that puts those facts together for one issue:
 *
 *   1. the pull request the issue is about — the open `pull_request` work
 *      product and its GitHub reference (`extractGitHubPullRequestReferences`);
 *   2. the diff of that pull request — `changedFiles`/`additions`/`deletions`
 *      of `PullRequestMergeDetails` (`github-pull-request-merge.ts`);
 *   3. the test and lint lanes of the CI run of the pull request head
 *      (`summarizeHeadLaneEvidence` in `github-pull-request-ci.ts`, the same
 *      lane names the Myrmidon CI workflow uses).
 *
 * Freshness has two independent conditions, both required:
 *   - the evidence belongs to the *current* head of the pull request;
 *   - it finished no longer ago than `SELF_CHECK_EVIDENCE_MAX_AGE_MS`.
 *
 * Deliberate invariant (`ложно, если…`): a missing pull request, an unreadable
 * reference, a CI read that failed (`unknown`), a pending lane, a lane of
 * another commit and an expired lane are all *not* evidence of green. Only a
 * green pair of lanes on the current head inside the window is `ok`, and the
 * diff must be numeric for gate input — `selfCheckEvidenceToGateInput` returns
 * `null` otherwise. A completed but red lane on the current head is `failed`:
 * still fresh evidence, and the gate (not this reader) names the code.
 *
 * No database, no network, no process: every external read is an injected
 * resolver, and a resolver failure is mapped to `unknown`, never to green.
 * Wiring lives outside (the gate composition root), so the domain here cannot
 * start a GitHub read on its own.
 */

import type { GitHubPullRequestReference } from "../../services/github-pull-request-merge.js";
import type {
  PullRequestHeadLane,
  PullRequestHeadLaneEvidence,
} from "../../services/github-pull-request-ci.js";
import { isSameCommitSha, parseTimestampToMs } from "./domain.js";
import type {
  MyrmidonDiffStats,
  MyrmidonRunCheckResult,
  SelfCheckGateInput,
} from "./domain.js";

/**
 * How old a finished test/lint lane may be and still count as evidence for the
 * current head. A green run of yesterday says nothing about today's commit even
 * when the SHA matches (a rebuilt or force-pushed head), so the window is a
 * second, independent condition on top of the head check.
 */
export const SELF_CHECK_EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;

export const SELF_CHECK_EVIDENCE_STATES = {
  /** Diff, test and lint evidence all belong to the current head, fresh and green. */
  OK: "ok",
  /** The issue has no open pull request work product: there is nothing to review. */
  NO_PULL_REQUEST: "no_pr",
  /** A lane is missing or still running: wait, never a pass. */
  PENDING: "pending",
  /** The evidence exists but belongs to another commit or is older than the window. */
  STALE: "stale",
  /** A completed lane finished non-green on the current head inside the window. */
  FAILED: "failed",
  /** The board could not read the pull request, its diff or its CI at all. */
  UNKNOWN: "unknown",
} as const;

export type SelfCheckEvidenceStatus =
  (typeof SELF_CHECK_EVIDENCE_STATES)[keyof typeof SELF_CHECK_EVIDENCE_STATES];

/** What the issue is about, as far as the board could read it. */
export interface SelfCheckEvidencePullRequest {
  readonly url: string | null;
  readonly repository: string | null;
  readonly number: number | null;
}

export interface SelfCheckEvidence {
  readonly status: SelfCheckEvidenceStatus;
  /**
   * Short machine-ish code of why the status is not `ok` (never a token, never
   * a header). `null` when the evidence is `ok`.
   */
  readonly reason: string | null;
  readonly pullRequest: SelfCheckEvidencePullRequest | null;
  /** The current head of the pull request; `null` when the board could not read it. */
  readonly headSha: string | null;
  /** `null` when GitHub did not report the counts: the gate then rejects as an empty diff. */
  readonly diff: MyrmidonDiffStats | null;
  readonly test: MyrmidonRunCheckResult | null;
  readonly lint: MyrmidonRunCheckResult | null;
  /** When this bundle was assembled (ISO), so a caller can log how old the read is. */
  readonly checkedAt: string;
}

/** The open pull request work product of the issue, or why there is none. */
export type SelfCheckEvidencePullRequestTarget =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly pullRequestUrl: string | null }
  | {
      readonly kind: "ok";
      readonly pullRequestUrl: string | null;
      readonly reference: GitHubPullRequestReference;
    };

/**
 * The part of `PullRequestMergeDetails` this reader needs. Structural, so the
 * real merge-details resolver can be passed as-is without importing it here.
 */
export interface SelfCheckEvidencePullRequestDetails {
  readonly headSha: string | null;
  readonly changedFiles?: number | null;
  readonly additions?: number | null;
  readonly deletions?: number | null;
}

/**
 * Every external read the reader performs. All of them are existing resolvers
 * of the board: the work-product lookup (`loadIssuePullRequestTarget` of the
 * review-stage-recovery module), `PullRequestMergeDetailsResolver` and the CI
 * lane selector (`resolveForPullRequest` → `summarizeHeadLaneEvidence`).
 */
export interface SelfCheckEvidenceDeps {
  readonly resolvePullRequestTarget: (input: {
    companyId: string;
    issueId: string;
  }) => Promise<SelfCheckEvidencePullRequestTarget>;
  readonly resolvePullRequestDetails: (
    companyId: string,
    reference: GitHubPullRequestReference,
  ) => Promise<SelfCheckEvidencePullRequestDetails>;
  readonly resolveHeadLaneEvidence: (input: {
    companyId: string;
    issueId: string;
    reference: GitHubPullRequestReference;
  }) => Promise<readonly PullRequestHeadLaneEvidence[]>;
}

export interface SelfCheckEvidenceInput {
  readonly companyId: string;
  readonly issueId: string;
  /** "Now" of the freshness window; defaults to the wall clock. */
  readonly evaluatedAt?: Date | string | number | null;
  /** Overrides `SELF_CHECK_EVIDENCE_MAX_AGE_MS`; `0`/negative disables the age condition. */
  readonly maxAgeMs?: number | null;
}

function diffOf(details: SelfCheckEvidencePullRequestDetails): MyrmidonDiffStats | null {
  const { changedFiles, additions, deletions } = details;
  if (
    typeof changedFiles !== "number" ||
    typeof additions !== "number" ||
    typeof deletions !== "number"
  ) {
    return null;
  }
  return { changedFiles, additions, deletions };
}

function pullRequestOf(
  target: SelfCheckEvidencePullRequestTarget,
): SelfCheckEvidencePullRequest | null {
  if (target.kind === "none") return null;
  if (target.kind === "unreadable") {
    return { url: target.pullRequestUrl, repository: null, number: null };
  }
  const { reference, pullRequestUrl } = target;
  return {
    url: pullRequestUrl,
    repository: `${reference.owner}/${reference.repo}`,
    number: reference.number,
  };
}

function laneOf(
  lanes: readonly PullRequestHeadLaneEvidence[],
  lane: PullRequestHeadLane,
): PullRequestHeadLaneEvidence | null {
  return lanes.find((candidate) => candidate.lane === lane) ?? null;
}

function runResultOf(lane: PullRequestHeadLaneEvidence): MyrmidonRunCheckResult {
  return {
    status: lane.state === "success" ? "success" : "failure",
    headSha: lane.headSha ?? "",
    finishedAt: lane.finishedAt ?? null,
  };
}

/**
 * Assemble the evidence for one issue. Total with respect to the outside
 * world: it only awaits the injected resolvers, maps every resolver failure to
 * `unknown`, and never decides "green" by default.
 */
export async function readSelfCheckEvidence(
  input: SelfCheckEvidenceInput,
  deps: SelfCheckEvidenceDeps,
): Promise<SelfCheckEvidence> {
  const checkedAt = new Date().toISOString();
  const base = {
    pullRequest: null,
    headSha: null,
    diff: null,
    test: null,
    lint: null,
    checkedAt,
  } as const;

  let target: SelfCheckEvidencePullRequestTarget;
  try {
    target = await deps.resolvePullRequestTarget({
      companyId: input.companyId,
      issueId: input.issueId,
    });
  } catch {
    return {
      ...base,
      status: SELF_CHECK_EVIDENCE_STATES.UNKNOWN,
      reason: "pull_request_target_read_failed",
    };
  }

  if (target.kind === "none") {
    return {
      ...base,
      status: SELF_CHECK_EVIDENCE_STATES.NO_PULL_REQUEST,
      reason: "no_pull_request_work_product",
    };
  }
  if (target.kind === "unreadable") {
    return {
      ...base,
      status: SELF_CHECK_EVIDENCE_STATES.UNKNOWN,
      reason: "pull_request_reference_unreadable",
      pullRequest: pullRequestOf(target),
    };
  }

  const { reference } = target;
  const pullRequest = pullRequestOf(target);

  let details: SelfCheckEvidencePullRequestDetails;
  try {
    details = await deps.resolvePullRequestDetails(input.companyId, reference);
  } catch {
    return {
      ...base,
      status: SELF_CHECK_EVIDENCE_STATES.UNKNOWN,
      reason: "pull_request_details_read_failed",
      pullRequest,
    };
  }

  const headSha = details.headSha ?? null;
  const diff = diffOf(details);

  if (!headSha) {
    return {
      ...base,
      status: SELF_CHECK_EVIDENCE_STATES.UNKNOWN,
      reason: "pull_request_head_unreadable",
      pullRequest,
      diff,
    };
  }

  let lanes: readonly PullRequestHeadLaneEvidence[];
  try {
    lanes = await deps.resolveHeadLaneEvidence({
      companyId: input.companyId,
      issueId: input.issueId,
      reference,
    });
  } catch {
    return {
      ...base,
      status: SELF_CHECK_EVIDENCE_STATES.UNKNOWN,
      reason: "ci_lanes_read_failed",
      pullRequest,
      headSha,
      diff,
    };
  }

  const testLane = laneOf(lanes, "test");
  const lintLane = laneOf(lanes, "lint");

  const withFacts = { ...base, pullRequest, headSha, diff };

  // 1. A lane that belongs to another commit is never evidence for this head —
  //    the "результат с чужого head" case of the stop-gate contract.
  for (const lane of [testLane, lintLane]) {
    if (lane && lane.headSha && !isSameCommitSha(lane.headSha, headSha)) {
      return { ...withFacts, status: SELF_CHECK_EVIDENCE_STATES.STALE, reason: `lane_head_mismatch:${lane.lane}` };
    }
  }

  // 2. A missing or still-running lane is a wait, never a pass; an unreadable
  //    lane state is unknown. Neither is ever laundered into green.
  if (!testLane || !lintLane) {
    const missing = !testLane ? "test" : "lint";
    return { ...withFacts, status: SELF_CHECK_EVIDENCE_STATES.PENDING, reason: `lane_missing:${missing}` };
  }
  for (const lane of [testLane, lintLane]) {
    if (lane.state === "missing") {
      return { ...withFacts, status: SELF_CHECK_EVIDENCE_STATES.PENDING, reason: `lane_missing:${lane.lane}` };
    }
    if (lane.state === "pending") {
      return { ...withFacts, status: SELF_CHECK_EVIDENCE_STATES.PENDING, reason: `lane_pending:${lane.lane}` };
    }
    if (lane.state === "unknown") {
      return { ...withFacts, status: SELF_CHECK_EVIDENCE_STATES.UNKNOWN, reason: `lane_unknown:${lane.lane}` };
    }
  }

  // 3. Freshness window: a lane older than the window is stale even on the
  //    same commit. A lane without a finish time cannot be shown as fresh.
  const maxAgeMs =
    input.maxAgeMs === undefined || input.maxAgeMs === null
      ? SELF_CHECK_EVIDENCE_MAX_AGE_MS
      : input.maxAgeMs;
  const evaluatedMs = parseTimestampToMs(input.evaluatedAt) ?? Date.now();

  for (const lane of [testLane, lintLane]) {
    const finishedMs = parseTimestampToMs(lane.finishedAt);
    if (finishedMs == null) {
      return {
        ...withFacts,
        status: SELF_CHECK_EVIDENCE_STATES.STALE,
        reason: `lane_without_finished_at:${lane.lane}`,
        test: runResultOf(testLane),
        lint: runResultOf(lintLane),
      };
    }
    if (maxAgeMs > 0 && evaluatedMs - finishedMs > maxAgeMs) {
      return {
        ...withFacts,
        status: SELF_CHECK_EVIDENCE_STATES.STALE,
        reason: `lane_older_than_window:${lane.lane}`,
        test: runResultOf(testLane),
        lint: runResultOf(lintLane),
      };
    }
  }

  // 4. Both lanes are complete, on the current head and inside the window.
  //    Green is `ok`; a red lane is still fresh evidence — status `failed`,
  //    and the gate names the exact code (TEST_FAILED / LINT_FAILED).
  const test = runResultOf(testLane);
  const lint = runResultOf(lintLane);

  if (testLane.state !== "success" || lintLane.state !== "success") {
    const red = testLane.state !== "success" ? "test" : "lint";
    return {
      ...withFacts,
      status: SELF_CHECK_EVIDENCE_STATES.FAILED,
      reason: `lane_failed:${red}`,
      test,
      lint,
    };
  }

  return {
    status: SELF_CHECK_EVIDENCE_STATES.OK,
    reason: null,
    pullRequest,
    headSha,
    diff,
    test,
    lint,
    checkedAt,
  };
}

/**
 * `true` only for strict green evidence: a pull request head, a numeric diff
 * and both lanes green on that head inside the window. Any other status is a
 * rejection — a missing PR or an unknown CI must never look like green.
 */
export function isSelfCheckEvidenceAdmissible(evidence: SelfCheckEvidence): boolean {
  return (
    evidence.status === SELF_CHECK_EVIDENCE_STATES.OK &&
    evidence.headSha !== null &&
    evidence.diff !== null &&
    evidence.test !== null &&
    evidence.lint !== null &&
    evidence.test.headSha !== "" &&
    evidence.lint.headSha !== ""
  );
}

/**
 * Turn evidence into `evaluateSelfCheckGate` input. `null` unless the bundle
 * carries a head, a numeric diff and both finished lanes on that head — i.e.
 * for every `ok` and `failed` bundle. The gate is the judge: a `failed`
 * bundle maps to its TEST_FAILED / LINT_FAILED rejection, and every other
 * status must be rejected by the caller with the evidence reason, so an
 * absent PR or an unknown CI cannot be laundered into a pass.
 */
export function selfCheckEvidenceToGateInput(
  evidence: SelfCheckEvidence,
): SelfCheckGateInput | null {
  const headSha = evidence.headSha;
  const diff = evidence.diff;
  const test = evidence.test;
  const lint = evidence.lint;
  if (
    (evidence.status !== SELF_CHECK_EVIDENCE_STATES.OK &&
      evidence.status !== SELF_CHECK_EVIDENCE_STATES.FAILED) ||
    headSha === null ||
    diff === null ||
    test === null ||
    lint === null ||
    test.headSha === "" ||
    lint.headSha === ""
  ) {
    return null;
  }
  return {
    currentHeadSha: headSha,
    diff,
    test,
    lint,
  };
}
