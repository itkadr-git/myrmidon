// Native PR approval propagation from board review APPROVE decisions.
//
// Automatically tags the linked pull request with `review-approved` and/or
// submits an approving GitHub PR review when a formal board review decision
// of APPROVE is reached or during PR sync review lane processing.

import { and, eq } from "drizzle-orm";
import { issueWorkProducts, issues, type Db } from "@myrmidon/db";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { resolveGitHubAppCredential } from "../myrmidon/github-shared-identity/resolve.js";
import { declaredReviewedHead } from "../myrmidon/review-routing/pr-policy.js";
import { notifyBoardMergeTrigger } from "../myrmidon/review-routing/merge-trigger.js";
import {
  type ReviewVerdictRecord,
} from "../myrmidon/review-verdict/record.js";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { gitHubApiBase } from "./github-fetch.js";
import { logger } from "../middleware/logger.js";
// myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): the board's public origin for
// the check run's `details_url`. Same env-only resolution as the chat-bridge
// links (issueService takes no options to thread config through).
import { resolveBoardPublicBaseUrl } from "../myrmidon/agent-chat-bridge/links.js";

export const REVIEW_APPROVED_LABEL = "review-approved";

/**
 * myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): name of the check run the board
 * writes on the PR head commit when a formal review decision is reached, so
 * the review state is visible in GitHub's checks UI without reading the board.
 * Part D (separate) grants the App the `checks:write` permission.
 */
export const BOARD_REVIEW_CHECK_RUN_NAME = "Board review";

export const PR_APPROVAL_ACTIVITY_PROPAGATED = "myrmidon.pr_approval.propagated";
export const PR_APPROVAL_ACTIVITY_SKIPPED = "myrmidon.pr_approval.skipped";
export const PR_APPROVAL_ACTIVITY_FAILED = "myrmidon.pr_approval.failed";

export const HEAD_SHA_PATTERN = /\bhead\b[^0-9a-fA-F\n]{0,8}([0-9a-fA-F]{7,40})\b/i;
export const APPROVAL_VERDICT_PATTERN = /\b(?:APPROVE|APPROVED|LGTM)\b/i;
export const NON_APPROVAL_VERDICT_PATTERN =
  /\b(?:RETURN|RETURNED|REWORK|DEFERRED|REJECT|REJECTED|BLOCK|BLOCKED|CHANGES[ \t]+REQUESTED|REQUEST[ \t]+CHANGES|SUPERSEDED)\b/i;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** True when text or outcome represents an approval decision. */
export function isApprovalOutcome(
  outcome?: string | null,
  verdictBody?: string | null,
  verdictRecord?: ReviewVerdictRecord | null,
): boolean {
  // myrmidon(OPE-12181, REVIEW-CHECKS-NATIVE): the structured record is
  // authoritative when present — the decision text is not re-parsed.
  if (verdictRecord) {
    return verdictRecord.reviewDecision === "approved";
  }
  if (outcome) {
    const o = outcome.trim().toLowerCase();
    if (o === "approved" || o === "approve") {
      // If verdict body explicitly says return/reject/changes requested, it is not an approval
      if (verdictBody && NON_APPROVAL_VERDICT_PATTERN.test(verdictBody)) {
        return false;
      }
      return true;
    }
    if (
      o === "changes_requested" ||
      o === "request_changes" ||
      o === "refuse" ||
      o === "refused" ||
      o === "rejected" ||
      o === "returned" ||
      o === "return"
    ) {
      return false;
    }
  }

  if (verdictBody) {
    if (NON_APPROVAL_VERDICT_PATTERN.test(verdictBody)) return false;
    if (APPROVAL_VERDICT_PATTERN.test(verdictBody)) return true;
  }

  return false;
}

/** Prefix or exact matching for git commit SHAs (case-insensitive). */
export function headMatches(
  reviewedHead: string | null | undefined,
  currentHead: string | null | undefined,
): boolean {
  if (!reviewedHead || !currentHead) return false;
  const a = reviewedHead.trim().toLowerCase();
  const b = currentHead.trim().toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Extracts the reviewed head sha from a verdict: the explicit `head 1234567`
 * spelling first, then (myrmidon(OPE-11767)) the first bare sha token — the
 * reviewers write `APPROVE PR #N <sha>`, which the explicit spelling alone
 * never matched (`missing_reviewed_head` on PR #2449 and #2467).
 */
export function parseReviewedHead(text: string | null | undefined): string | null {
  return declaredReviewedHead(text);
}

/** Extracts PR coordinates (repository and PR number) from text. */
export function parsePullRequestCoordinates(
  text: string | null | undefined,
  defaultRepo?: string | null,
): { repository: string; number: number } | null {
  if (!text) return null;
  const urlMatch = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/i.exec(text);
  if (urlMatch) {
    return { repository: urlMatch[1], number: parseInt(urlMatch[2], 10) };
  }
  const shorthandMatch = /(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/.exec(text);
  if (shorthandMatch) {
    return { repository: shorthandMatch[1], number: parseInt(shorthandMatch[2], 10) };
  }
  if (defaultRepo) {
    const numMatch = /(?:PR\s*)?#([1-9][0-9]*)\b/i.exec(text);
    if (numMatch) {
      return { repository: defaultRepo, number: parseInt(numMatch[1], 10) };
    }
  }
  return null;
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  let delay = options.initialDelayMs ?? 100;
  const factor = options.backoffFactor ?? 2;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const shouldRetry = options.shouldRetry ? options.shouldRetry(err) : defaultShouldRetry(err);
      if (!shouldRetry) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= factor;
    }
  }
  throw lastError;
}

function defaultShouldRetry(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    const status = Number((err as { status: unknown }).status);
    if (status === 429 || status >= 500) return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("fetch") || msg.includes("network") || msg.includes("timeout") || msg.includes("econnreset")) {
      return true;
    }
  }
  return false;
}

export interface GitHubPullRequestDetails {
  state: string;
  draft: boolean;
  merged: boolean;
  headSha: string;
  labels: string[];
}

export interface GitHubApprovalClient {
  getPullRequest(input: {
    repository: string;
    number: number;
    token: string;
  }): Promise<GitHubPullRequestDetails>;
  addLabel(input: {
    repository: string;
    number: number;
    label: string;
    token: string;
  }): Promise<void>;
  removeLabel?(input: {
    repository: string;
    number: number;
    label: string;
    token: string;
  }): Promise<void>;
  submitReview(input: {
    repository: string;
    number: number;
    headSha: string;
    event: "APPROVE";
    body?: string;
    token: string;
  }): Promise<{ id?: number | string; skipped?: boolean }>;
  /**
   * myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): writes the board's own check
   * run on the head commit. `conclusion` is "success" for an approval and
   * "failure" for changes requested. Implementations may be absent — the
   * propagation keeps working without the check run.
   */
  createCheckRun?(input: {
    repository: string;
    headSha: string;
    name: string;
    conclusion: "success" | "failure";
    detailsUrl?: string;
    title: string;
    summary: string;
    token: string;
  }): Promise<{ id?: number | string }>;
  /**
   * myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): lists the board's check runs
   * on the head commit, for idempotency of repeated decisions on the same
   * head. Implementations may be absent.
   */
  listCheckRuns?(input: {
    repository: string;
    headSha: string;
    name: string;
    token: string;
  }): Promise<Array<{ id: number | string; conclusion: string | null }>>;
  listReviews?(input: {
    repository: string;
    number: number;
    token: string;
  }): Promise<Array<{ id: number | string; state: string; commitId?: string }>>;
}

export function createDefaultGitHubApprovalClient(
  fetchFn: FetchLike = fetch,
  apiBase = "https://api.github.com",
): GitHubApprovalClient {
  const ghHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "myrmidon-board",
  });

  return {
    async getPullRequest({ repository, number, token }) {
      const res = await fetchFn(`${apiBase}/repos/${repository}/pulls/${number}`, {
        headers: ghHeaders(token),
      });
      if (!res.ok) {
        const error = new Error(`GitHub getPullRequest failed with HTTP ${res.status}`);
        (error as { status?: number }).status = res.status;
        throw error;
      }
      const data = (await res.json()) as Record<string, unknown>;
      const rawLabels = Array.isArray(data.labels) ? data.labels : [];
      const labels = rawLabels.map((item: unknown) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "name" in item) {
          return String((item as { name: unknown }).name);
        }
        return "";
      }).filter(Boolean);

      const head = (data.head && typeof data.head === "object" ? data.head : {}) as Record<string, unknown>;

      return {
        state: String(data.state ?? ""),
        draft: Boolean(data.draft),
        merged: Boolean(data.merged || data.merged_at),
        headSha: String(head.sha ?? ""),
        labels,
      };
    },

    async addLabel({ repository, number, label, token }) {
      const res = await fetchFn(`${apiBase}/repos/${repository}/issues/${number}/labels`, {
        method: "POST",
        headers: {
          ...ghHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ labels: [label] }),
      });
      if (!res.ok) {
        const error = new Error(`GitHub addLabel failed with HTTP ${res.status}`);
        (error as { status?: number }).status = res.status;
        throw error;
      }
    },

    async removeLabel({ repository, number, label, token }) {
      const res = await fetchFn(
        `${apiBase}/repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`,
        {
          method: "DELETE",
          headers: ghHeaders(token),
        },
      );
      // 404: the label is not present (idempotent); treat as success.
      if (!res.ok && res.status !== 404) {
        const error = new Error(`GitHub removeLabel failed with HTTP ${res.status}`);
        (error as { status?: number }).status = res.status;
        throw error;
      }
    },

    async submitReview({ repository, number, headSha, event, body, token }) {
      const res = await fetchFn(`${apiBase}/repos/${repository}/pulls/${number}/reviews`, {
        method: "POST",
        headers: {
          ...ghHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          commit_id: headSha,
          event,
          body: body ?? "Approved by board review",
        }),
      });

      if (res.status === 422) {
        // HTTP 422: Can occur if PR author cannot approve own PR, or review already submitted
        return { skipped: true };
      }

      if (!res.ok) {
        const error = new Error(`GitHub submitReview failed with HTTP ${res.status}`);
        (error as { status?: number }).status = res.status;
        throw error;
      }

      const data = (await res.json()) as Record<string, unknown>;
      return { id: data.id as number | string | undefined };
    },

    async listReviews({ repository, number, token }) {
      const res = await fetchFn(`${apiBase}/repos/${repository}/pulls/${number}/reviews`, {
        headers: ghHeaders(token),
      });
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as unknown[];
      if (!Array.isArray(data)) return [];
      return data.map((item) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
          id: record.id as number | string,
          state: String(record.state ?? ""),
          commitId: typeof record.commit_id === "string" ? record.commit_id : undefined,
        };
      });
    },

    // myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): the board's check run on the
    // PR head commit. Requires the App installation to hold `checks:write`;
    // GitHub answers 403 (or 404) without it and the caller degrades to warn.
    async createCheckRun({ repository, headSha, name, conclusion, detailsUrl, title, summary, token }) {
      const res = await fetchFn(`${apiBase}/repos/${repository}/check-runs`, {
        method: "POST",
        headers: {
          ...ghHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          head_sha: headSha,
          status: "completed",
          conclusion,
          details_url: detailsUrl,
          output: { title, summary },
        }),
      });
      if (!res.ok) {
        const error = new Error(`GitHub createCheckRun failed with HTTP ${res.status}`);
        (error as { status?: number }).status = res.status;
        throw error;
      }
      const data = (await res.json()) as Record<string, unknown>;
      return { id: data.id as number | string | undefined };
    },

    // `filter=latest` is enough here: the idempotency check only asks whether
    // the named check has any (completed) run on this exact commit.
    async listCheckRuns({ repository, headSha, name, token }) {
      const res = await fetchFn(
        `${apiBase}/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs` +
          `?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
        { headers: ghHeaders(token) },
      );
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as Record<string, unknown>;
      const runs = Array.isArray(data.check_runs) ? data.check_runs : [];
      return runs.map((item) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
          id: record.id as number | string,
          conclusion: typeof record.conclusion === "string" ? record.conclusion : null,
        };
      });
    },
  };
}

export async function resolveGitHubTokenForApproval(
  db: Db,
  companyId: string,
  repository?: string,
  identity?: {
    agentId?: string | null;
    runId?: string | null;
    issueId?: string | null;
  },
): Promise<string | null> {
  // Review approval is an operation on behalf of the reviewer run. Resolve the
  // repository-scoped shared identity first so PAT rules (as well as Apps) are
  // honored for repositories that are not covered by the board App.
  if (repository && identity?.agentId && identity.runId) {
    try {
      const secrets = secretService(db);
      const resolution = await resolveGitHubAppCredential(
        db,
        { resolveSecretValue: (companyId, secretId, version, options) => secrets.resolveSecretValue(companyId, secretId, version, options) },
        {
          companyId,
          agentId: identity.agentId,
          runId: identity.runId,
          issueId: identity.issueId ?? null,
          repository,
        },
      );
      if (resolution.kind === "issued") return resolution.credential.token;
      if (resolution.kind === "ambiguous" || resolution.kind === "error") return null;
    } catch {
      // Preserve the legacy secret fallback below for older installations.
    }
  }

  const secrets = secretService(db);
  for (const name of DEFAULT_GITHUB_TOKEN_SECRET_NAMES) {
    try {
      const secret = await secrets.getByName(companyId, name);
      if (!secret) continue;
      const value = await secrets.resolveSecretValue(companyId, secret.id, "latest");
      const trimmed = value?.trim();
      if (trimmed) return trimmed;
    } catch {
      // Continue to next secret candidate
    }
  }

  if (repository) {
    try {
      const { readGitHubSharedIdentitySettings } = await import("../myrmidon/github-shared-identity/index.js");
      const settings = await readGitHubSharedIdentitySettings(db, companyId);
      if (settings?.enabled && settings.apps && settings.apps.length > 0) {
        const app = settings.apps[0]!;
        const keyVal = await secrets.resolveSecretValue(companyId, app.privateKeySecretId, "latest");
        if (keyVal) {
          const { mintGitHubAppInstallationToken } = await import("../myrmidon/github-shared-identity/app-token.js");
          const minted = await mintGitHubAppInstallationToken({
            appId: app.appId,
            privateKeyPem: keyVal,
            installationId: app.installationId,
            repository,
            permissions: { pull_requests: "write", issues: "write" },
          });
          if (minted?.token) return minted.token;
        }
      }
    } catch {
      // App broker resolution optional
    }
  }

  return null;
}

export interface PropagateReviewApprovalInput {
  companyId: string;
  issueId?: string;
  repository?: string;
  number?: number;
  headSha?: string;
  reviewedHeadSha?: string | null;
  decisionOutcome?: string | null;
  verdictBody?: string | null;
  /**
   * myrmidon(OPE-12181, REVIEW-CHECKS-NATIVE): the structured verdict record
   * extracted once at decision time. When present it is authoritative and the
   * verdict text is not re-parsed; null keeps the legacy text fallback.
   */
  verdictRecord?: ReviewVerdictRecord | null;
  actor?: {
    actorType: "agent" | "user" | "system" | "plugin";
    actorId: string;
    agentId?: string | null;
    runId?: string | null;
  } | null;
}

export interface PropagateReviewApprovalResult {
  success: boolean;
  action: "propagated" | "noop" | "skipped" | "failed";
  reason?: string;
  repository?: string;
  pullRequestNumber?: number;
  currentHeadSha?: string;
  reviewedHeadSha?: string;
  labelAdded?: boolean;
  reviewSubmitted?: boolean;
  /** myrmidon(OPE-12182): the Board review check run was written on the head. */
  checkRunCreated?: boolean;
  /** myrmidon(OPE-12182): the check run write failed (e.g. no checks:write). */
  checkRunFailed?: boolean;
}

export interface PropagateReviewApprovalDeps {
  db: Db;
  client?: GitHubApprovalClient;
  tokenProvider?: (companyId: string, repository?: string, identity?: { agentId?: string | null; runId?: string | null; issueId?: string | null }) => Promise<string | null>;
  retryOptions?: RetryOptions;
  /**
   * myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): board origin for the check
   * run's `details_url` (e.g. `https://board.example.com`); the run then links
   * to `/issues/<id>`. Null/undefined leaves `details_url` out.
   */
  boardBaseUrl?: string | null;
}

/**
 * myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): writes the board's own check run
 * ("Board review") on the reviewed head commit — `success` after an approval,
 * `failure` after a changes-requested decision — with `details_url` pointing at
 * the board issue.
 *
 * Degradation: the permission is part D; until the App installation holds
 * `checks:write`, GitHub answers 403/404. That is warned and journalled as
 * `myrmidon.pr_approval.failed` (reason `check_run_failed`), never raised —
 * the review itself already succeeded and the propagation must not fail the
 * review flow because of a missing permission. Network/transport errors
 * (`executeWithRetry` exhaustion) degrade the same way.
 *
 * Idempotency: when the client can list check runs, an existing run of the
 * same name on the same head skips the POST, so a repeated APPROVE of one head
 * never accumulates duplicate "Board review" runs on that commit.
 */
async function upsertBoardReviewCheckRun(
  deps: PropagateReviewApprovalDeps,
  input: PropagateReviewApprovalInput,
  boardBaseUrl: string | null | undefined,
  client: GitHubApprovalClient,
  tokenProvider: NonNullable<PropagateReviewApprovalDeps["tokenProvider"]>,
  repository: string,
  headSha: string,
  reviewDecision: "approved" | "changes_requested",
): Promise<{ created: boolean; failed: boolean; skippedDuplicate: boolean }> {
  if (typeof client.createCheckRun !== "function") return { created: false, failed: false, skippedDuplicate: false };

  const token = await tokenProvider(input.companyId, repository, {
    agentId: input.actor?.agentId ?? null,
    runId: input.actor?.runId ?? null,
    issueId: input.issueId ?? null,
  });
  if (!token) {
    logger.warn({ repository, headSha }, "board review check run skipped: no GitHub token");
    return { created: false, failed: false, skippedDuplicate: false };
  }

  const desiredConclusion = reviewDecision === "approved" ? "success" : "failure";
  try {
    if (typeof client.listCheckRuns === "function") {
      const existing = await executeWithRetry(
        () => client.listCheckRuns!({ repository, headSha, name: BOARD_REVIEW_CHECK_RUN_NAME, token }),
        deps.retryOptions,
      );
      if (existing.some((run) => run.conclusion === desiredConclusion)) {
        return { created: false, failed: false, skippedDuplicate: true };
      }
    }

    const summary = reviewDecision === "approved"
      ? "Review decision: APPROVE. The formal board review approved the pull request head."
      : "Review decision: REQUEST CHANGES. The formal board review requested changes on the pull request head.";
    const detailsUrl = input.issueId && boardBaseUrl
      ? new URL(`/issues/${input.issueId}`, boardBaseUrl).toString()
      : undefined;

    await executeWithRetry(
      () =>
        client.createCheckRun!({
          repository,
          headSha,
          name: BOARD_REVIEW_CHECK_RUN_NAME,
          conclusion: desiredConclusion,
          detailsUrl,
          title: `Board review: ${reviewDecision === "approved" ? "approved" : "changes requested"}`,
          summary,
          token,
        }),
      deps.retryOptions,
    );
    return { created: true, failed: false, skippedDuplicate: false };
  } catch (err) {
    logger.warn({ err, repository, headSha, name: BOARD_REVIEW_CHECK_RUN_NAME }, "failed to create the Board review check run");
    if (input.issueId) {
      await logActivity(deps.db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "system",
        agentId: input.actor?.agentId ?? null,
        runId: input.actor?.runId ?? null,
        action: PR_APPROVAL_ACTIVITY_FAILED,
        entityType: "issue",
        entityId: input.issueId,
        details: {
          repository,
          headSha,
          name: BOARD_REVIEW_CHECK_RUN_NAME,
          reason: "check_run_failed",
          error: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => {});
    }
    return { created: false, failed: true, skippedDuplicate: false };
  }
}

/** Flat `checkRunCreated`/`checkRunFailed` fields for a propagation result. */
function checkRunFields(outcome: { created: boolean; failed: boolean }): Pick<PropagateReviewApprovalResult, "checkRunCreated" | "checkRunFailed"> {
  return { checkRunCreated: outcome.created, checkRunFailed: outcome.failed };
}

/**
 * Propagate board review approval to a linked GitHub pull request.
 */
export async function propagateReviewApprovalToPullRequest(
  deps: PropagateReviewApprovalDeps,
  input: PropagateReviewApprovalInput,
): Promise<PropagateReviewApprovalResult> {
  const client = deps.client ?? createDefaultGitHubApprovalClient();
  const tokenProvider = deps.tokenProvider ?? ((c, r, identity) => resolveGitHubTokenForApproval(deps.db, c, r, identity));
  const boardBaseUrl = deps.boardBaseUrl ?? resolveBoardPublicBaseUrl();

  // myrmidon(OPE-12181, REVIEW-CHECKS-NATIVE): an explicit structured record
  // wins; a record may also arrive via the issue's execution state when the
  // caller passes state instead of a parsed record. Without a record the
  // legacy text parsing below stays as the fallback for old tickets.
  const verdictRecord = input.verdictRecord ?? null;

  // Negative path verification
  const isNonApproval = verdictRecord
    ? verdictRecord.reviewDecision !== "approved"
    : (input.decisionOutcome != null && !isApprovalOutcome(input.decisionOutcome, input.verdictBody)) ||
      (input.verdictBody != null && NON_APPROVAL_VERDICT_PATTERN.test(input.verdictBody));
  // myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): a REQUEST CHANGES decision
  // still lands on GitHub — as the same check run with `conclusion: failure`
  // on the current head — so the checks UI shows a red "Board review" instead
  // of a stale green one. Everything past the decision below is therefore
  // shared; only the check-run conclusion differs. `reviewDecision` names the
  // formal outcome the check mirrors ("approved" | "changes_requested").
  const reviewDecision: "approved" | "changes_requested" = isNonApproval
    ? "changes_requested"
    : "approved";
  if (isNonApproval) {
    if (input.issueId) {
      await logActivity(deps.db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "system",
        agentId: input.actor?.agentId ?? null,
        runId: input.actor?.runId ?? null,
        action: PR_APPROVAL_ACTIVITY_SKIPPED,
        entityType: "issue",
        entityId: input.issueId,
        details: {
          reason: "non_approval",
          decisionOutcome: input.decisionOutcome ?? null,
        },
      }).catch(() => {});
    }
  }

  // Determine target PR coordinates and reviewed head. The structured record's
  // head sha comes before re-parsing the verdict text (OPE-12181).
  let targetRepo = input.repository ?? null;
  let targetNumber = input.number ?? null;
  let reviewedHead = input.reviewedHeadSha ??
    verdictRecord?.headSha ??
    parseReviewedHead(input.verdictBody) ??
    input.headSha ?? null;

  let matchedWorkProduct: typeof issueWorkProducts.$inferSelect | null = null;

  if (input.issueId) {
    try {
      const products = await deps.db
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, input.companyId),
            eq(issueWorkProducts.issueId, input.issueId),
            eq(issueWorkProducts.type, "pull_request"),
          ),
        );

      for (const wp of products) {
        const metadata = (wp.metadata && typeof wp.metadata === "object" ? wp.metadata : {}) as Record<string, unknown>;
        let repo = typeof metadata.repo === "string" ? metadata.repo : (typeof metadata.repository === "string" ? metadata.repository : null);
        let num = typeof metadata.number === "number" ? metadata.number : (typeof metadata.pullRequestNumber === "number" ? metadata.pullRequestNumber : null);
        const head = typeof metadata.headSha === "string" ? metadata.headSha : null;

        if ((!repo || !num) && wp.url) {
          const parsed = parsePullRequestCoordinates(wp.url);
          if (parsed) {
            repo = repo ?? parsed.repository;
            num = num ?? parsed.number;
          }
        }

        if (targetRepo && targetNumber) {
          if (repo === targetRepo && num === targetNumber) {
            matchedWorkProduct = wp;
            if (!reviewedHead && head) reviewedHead = head;
            break;
          }
        } else if (repo && num) {
          targetRepo = repo;
          targetNumber = num;
          if (!reviewedHead && head) reviewedHead = head;
          matchedWorkProduct = wp;
          break;
        }
      }

      if (!matchedWorkProduct && products.length === 1) {
        matchedWorkProduct = products[0]!;
        const metadata = (matchedWorkProduct.metadata && typeof matchedWorkProduct.metadata === "object" ? matchedWorkProduct.metadata : {}) as Record<string, unknown>;
        const head = typeof metadata.headSha === "string" ? metadata.headSha : null;
        if (!reviewedHead && head) reviewedHead = head;
      }
    } catch (err) {
      logger.warn({ err, issueId: input.issueId }, "failed to read issue work products for PR approval propagation");
    }
  }

  // Fall back to parsing PR from verdictBody or issue description. With a
  // structured record the PR number comes from data first (OPE-12181).
  if ((!targetRepo || !targetNumber) && (input.verdictBody || input.issueId)) {
    let contextText = input.verdictBody ?? "";
    if (input.issueId && !contextText) {
      try {
        const [issueRow] = await deps.db
          .select({ description: issues.description })
          .from(issues)
          .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
          .limit(1);
        contextText = issueRow?.description ?? "";
      } catch {}
    }
    if (!targetNumber && verdictRecord?.pullRequestNumber) {
      targetNumber = verdictRecord.pullRequestNumber;
    }
    const parsed = parsePullRequestCoordinates(contextText, targetRepo);
    if (parsed) {
      targetRepo = parsed.repository;
      targetNumber = parsed.number;
    }
  }

  if (!targetRepo || !targetNumber) {
    return { success: false, action: "skipped", reason: "no_linked_pr" };
  }

  // myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): a non-approval decision
  // without an explicitly declared head (input field, structured verdict
  // record) stays a silent legacy skip with no GitHub calls — the text-parsed
  // fallback heads of old RETURN tickets are not check-run material. Only a
  // formal decision that names the head it judged continues past the head
  // guard below and lands the red "Board review" check there.
  const explicitReviewedHead = input.reviewedHeadSha ?? input.headSha ?? verdictRecord?.headSha ?? null;
  if (isNonApproval && !explicitReviewedHead) {
    return { success: false, action: "skipped", reason: "non_approval" };
  }

  // Requirement 5: Authorization check
  const token = await tokenProvider(input.companyId, targetRepo, {
    agentId: input.actor?.agentId ?? null,
    runId: input.actor?.runId ?? null,
    issueId: input.issueId ?? null,
  });
  if (!token) {
    if (input.issueId) {
      await logActivity(deps.db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "system",
        agentId: input.actor?.agentId ?? null,
        runId: input.actor?.runId ?? null,
        action: PR_APPROVAL_ACTIVITY_FAILED,
        entityType: "issue",
        entityId: input.issueId,
        details: {
          repository: targetRepo,
          pullRequestNumber: targetNumber,
          reason: "missing_credentials",
        },
      }).catch(() => {});
    }
    return { success: false, action: "failed", reason: "missing_credentials" };
  }

  // Fetch PR from GitHub with retry policy
  let prDetails: GitHubPullRequestDetails | null = null;
  try {
    prDetails = await executeWithRetry(
      () => client.getPullRequest({ repository: targetRepo!, number: targetNumber!, token }),
      deps.retryOptions,
    );
  } catch (err) {
    if (input.issueId) {
      await logActivity(deps.db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "system",
        agentId: input.actor?.agentId ?? null,
        runId: input.actor?.runId ?? null,
        action: PR_APPROVAL_ACTIVITY_FAILED,
        entityType: "issue",
        entityId: input.issueId,
        details: {
          repository: targetRepo,
          pullRequestNumber: targetNumber,
          reason: "github_fetch_failed",
          error: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => {});
    }
    return {
      success: false,
      action: "failed",
      reason: "github_fetch_failed",
      repository: targetRepo,
      pullRequestNumber: targetNumber,
    };
  }

  if (!prDetails) {
    if (input.issueId) {
      await logActivity(deps.db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "system",
        agentId: input.actor?.agentId ?? null,
        runId: input.actor?.runId ?? null,
        action: PR_APPROVAL_ACTIVITY_FAILED,
        entityType: "issue",
        entityId: input.issueId,
        details: {
          repository: targetRepo,
          pullRequestNumber: targetNumber,
          reason: "github_fetch_failed",
          error: "PR details not found",
        },
      }).catch(() => {});
    }
    return {
      success: false,
      action: "failed",
      reason: "github_fetch_failed",
      repository: targetRepo,
      pullRequestNumber: targetNumber,
    };
  }

  if (prDetails.state !== "open" || prDetails.draft || prDetails.merged) {
    if (input.issueId) {
      await logActivity(deps.db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "system",
        agentId: input.actor?.agentId ?? null,
        runId: input.actor?.runId ?? null,
        action: PR_APPROVAL_ACTIVITY_SKIPPED,
        entityType: "issue",
        entityId: input.issueId,
        details: {
          repository: targetRepo,
          pullRequestNumber: targetNumber,
          state: prDetails.state,
          draft: prDetails.draft,
          merged: prDetails.merged,
          reason: "pr_not_open_or_draft",
        },
      }).catch(() => {});
    }
    return {
      success: false,
      action: "skipped",
      reason: "pr_not_open_or_draft",
      repository: targetRepo,
      pullRequestNumber: targetNumber,
    };
  }

  // Requirement 2: Current-head guard (fail-closed if reviewed head is missing or moved)
  if (!reviewedHead || !headMatches(reviewedHead, prDetails.headSha)) {
    const reason = !reviewedHead ? "missing_reviewed_head" : "head_mismatch";
    if (input.issueId) {
      await logActivity(deps.db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "system",
        agentId: input.actor?.agentId ?? null,
        runId: input.actor?.runId ?? null,
        action: PR_APPROVAL_ACTIVITY_SKIPPED,
        entityType: "issue",
        entityId: input.issueId,
        details: {
          repository: targetRepo,
          pullRequestNumber: targetNumber,
          currentHeadSha: prDetails.headSha,
          reviewedHeadSha: reviewedHead,
          reason,
        },
      }).catch(() => {});
    }
    return {
      success: false,
      action: "skipped",
      reason,
      repository: targetRepo,
      pullRequestNumber: targetNumber,
      currentHeadSha: prDetails.headSha,
      reviewedHeadSha: reviewedHead ?? undefined,
    };
  }
  // myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): the head the verdict named is
  // authoritative for the check run too — the check lands on the declared head
  // only, never on a commit the reviewer did not see.
  const checkRunHeadSha = reviewedHead;

  // myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): a REQUEST CHANGES decision
  // never adds the `review-approved` label or an approving review — GitHub gets
  // only the red "Board review" check run (conclusion: failure) on the reviewed
  // head, so the checks UI shows the rejection instead of a stale green check.
  if (reviewDecision === "changes_requested") {
    const upsertOutcome = await upsertBoardReviewCheckRun(deps, input, boardBaseUrl, client, tokenProvider, targetRepo, checkRunHeadSha, reviewDecision);
    return {
      success: !upsertOutcome.failed,
      action: "skipped",
      reason: "non_approval",
      repository: targetRepo,
      pullRequestNumber: targetNumber,
      currentHeadSha: prDetails.headSha,
      reviewedHeadSha: reviewedHead ?? prDetails.headSha,
      ...(checkRunFields(upsertOutcome)),
    };
  }

  // Requirement 4: Idempotency & Recovery
  const alreadyLabeled = prDetails.labels.includes(REVIEW_APPROVED_LABEL);

  // Check if an approving GitHub review is already submitted on this head
  let alreadyHasApprovedReview = false;
  // myrmidon(OPE-12024): true when an APPROVED review is pinned to a commit
  // that is NOT the current head — i.e. the head moved after that approval.
  // The `review-approved` label event fired on the old head, so the label must
  // be re-seated for the labeled-triggered hot-files-review workflow to fire
  // on the current head (OPE-9646, PR #2352).
  let hasApprovedReviewOnMovedHead = false;
  let canCheckReviews = false;
  if (typeof client.listReviews === "function") {
    canCheckReviews = true;
    try {
      const existingReviews = await executeWithRetry(
        () => client.listReviews!({ repository: targetRepo!, number: targetNumber!, token }),
        deps.retryOptions,
      );
      alreadyHasApprovedReview = existingReviews.some(
        (r) => r.state === "APPROVED" && (!r.commitId || headMatches(r.commitId, prDetails.headSha)),
      );
      hasApprovedReviewOnMovedHead = existingReviews.some(
        (r) => r.state === "APPROVED" && !!r.commitId && !headMatches(r.commitId, prDetails.headSha),
      );
    } catch {
      // Best-effort check; proceed to ensure review/label
    }
  }

  // myrmidon(OPE-12024): the `review-approved` label fires the labeled-triggered
  // `myrmidon-hot-files-review` workflow, which sets a required status on the
  // commit that carries the label event.  When the PR head moved after an
  // earlier approval (force-push / rebuild), the label sits on the old head and
  // the new head never gets the required status — GitHub blocks the merge
  // (OPE-9646, PR #2352).  Re-seat the label: remove it, then add it again so
  // the labeled event fires on the current head.  Only re-seat when a review
  // approval actually exists on an older head — otherwise every propagation
  // cycle would churn the label (remove+add) even though nothing moved.
  let labelReseated = false;
  if (
    alreadyLabeled &&
    canCheckReviews &&
    alreadyHasApprovedReview &&
    hasApprovedReviewOnMovedHead &&
    typeof client.removeLabel === "function"
  ) {
    try {
      await executeWithRetry(
        () => client.removeLabel!({ repository: targetRepo!, number: targetNumber!, label: REVIEW_APPROVED_LABEL, token }),
        deps.retryOptions,
      );
      await executeWithRetry(
        () => client.addLabel({ repository: targetRepo!, number: targetNumber!, label: REVIEW_APPROVED_LABEL, token }),
        deps.retryOptions,
      );
      labelReseated = true;
    } catch (err) {
      logger.warn({ err, repository: targetRepo, number: targetNumber }, "failed to reseat review-approved label on moved head");
    }
  }

  // If already labeled, and either client cannot inspect reviews or an approving review is already present: complete no-op
  if (alreadyLabeled && !labelReseated && (!canCheckReviews || alreadyHasApprovedReview)) {
    const upsertOutcome = await upsertBoardReviewCheckRun(deps, input, boardBaseUrl, client, tokenProvider, targetRepo, checkRunHeadSha, reviewDecision);
    return {
      success: true,
      action: "noop",
      reason: "already_labeled",
      repository: targetRepo,
      pullRequestNumber: targetNumber,
      currentHeadSha: prDetails.headSha,
      reviewedHeadSha: reviewedHead ?? prDetails.headSha,
      ...(checkRunFields(upsertOutcome)),
    };
  }

  // Requirement 1: Tag with review-approved and/or submit approving PR review
  let labelAdded = false;
  if (!alreadyLabeled || labelReseated) {
    if (!alreadyLabeled) {
      try {
        await executeWithRetry(
          () => client.addLabel({ repository: targetRepo!, number: targetNumber!, label: REVIEW_APPROVED_LABEL, token }),
          deps.retryOptions,
        );
        labelAdded = true;
      } catch (err) {
        logger.warn({ err, repository: targetRepo, number: targetNumber }, "failed to add review-approved label to PR");
      }
    } else {
      // The label was just reseated (removed + re-added) on the current head.
      labelAdded = true;
    }
  }

  let reviewSubmitted = false;
  if (!alreadyHasApprovedReview) {
    try {
      const reviewRes = await executeWithRetry(
        () =>
          client.submitReview({
            repository: targetRepo!,
            number: targetNumber!,
            headSha: prDetails.headSha,
            event: "APPROVE",
            body: input.verdictBody ?? "Approved by board review",
            token,
          }),
        deps.retryOptions,
      );
      if (reviewRes && !reviewRes.skipped) {
        reviewSubmitted = true;
      }
    } catch (err) {
      logger.warn({ err, repository: targetRepo, number: targetNumber }, "failed to submit approving PR review");
    }
  }

  // Update matched work product metadata if present
  if (matchedWorkProduct) {
    try {
      const existingMeta = (matchedWorkProduct.metadata && typeof matchedWorkProduct.metadata === "object"
        ? matchedWorkProduct.metadata
        : {}) as Record<string, unknown>;
      await deps.db
        .update(issueWorkProducts)
        .set({
          metadata: {
            ...existingMeta,
            lastApprovedHeadSha: prDetails.headSha,
            reviewApprovedAt: new Date().toISOString(),
          },
        })
        .where(eq(issueWorkProducts.id, matchedWorkProduct.id));
    } catch (err) {
      logger.warn({ err, workProductId: matchedWorkProduct.id }, "failed to update work product metadata");
    }
  }

  // Requirement 5: Audit trail in activity log
  const upsertOutcome = await upsertBoardReviewCheckRun(deps, input, boardBaseUrl, client, tokenProvider, targetRepo, checkRunHeadSha, reviewDecision);
  if (input.issueId) {
    await logActivity(deps.db, {
      companyId: input.companyId,
      actorType: input.actor?.actorType ?? "system",
      actorId: input.actor?.actorId ?? "system",
      agentId: input.actor?.agentId ?? null,
      runId: input.actor?.runId ?? null,
      action: PR_APPROVAL_ACTIVITY_PROPAGATED,
      entityType: "issue",
      entityId: input.issueId,
      details: {
        repository: targetRepo,
        pullRequestNumber: targetNumber,
        headSha: prDetails.headSha,
        reviewedHeadSha: reviewedHead ?? prDetails.headSha,
        labelAdded,
        reviewSubmitted,
        checkRunCreated: upsertOutcome.created,
        checkRunFailed: upsertOutcome.failed,
      },
    }).catch(() => {});
  }

  return {
    success: labelAdded || reviewSubmitted,
    action: "propagated",
    repository: targetRepo,
    pullRequestNumber: targetNumber,
    currentHeadSha: prDetails.headSha,
    reviewedHeadSha: reviewedHead ?? prDetails.headSha,
    labelAdded,
    reviewSubmitted,
    ...(checkRunFields(upsertOutcome)),
  };
}

/**
 * Convenience wrapper that uses default dependencies for immediate invocation.
 *
 * myrmidon(OPE-11767): an approval is also the moment the board may merge the
 * PR itself (CI can already be green). The merge trigger is told once the
 * propagation settled — whatever it answered: the board's merge does not
 * depend on the label/review the propagation writes on GitHub. A listener
 * failure never reaches the caller.
 */
export async function triggerReviewApprovalPropagation(
  db: Db,
  input: PropagateReviewApprovalInput,
): Promise<PropagateReviewApprovalResult> {
  try {
    return await propagateReviewApprovalToPullRequest({ db }, input);
  } finally {
    if (input.issueId && (input.verdictRecord
      ? input.verdictRecord.reviewDecision === "approved"
      : (input.decisionOutcome == null || isApprovalOutcome(input.decisionOutcome, input.verdictBody)))) {
      notifyBoardMergeTrigger({ companyId: input.companyId, issueId: input.issueId, source: "review_approved" });
    }
  }
}
