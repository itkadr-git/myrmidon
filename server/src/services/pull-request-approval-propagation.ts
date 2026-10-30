// Native PR approval propagation from board review APPROVE decisions.
//
// Automatically tags the linked pull request with `review-approved` and/or
// submits an approving GitHub PR review when a formal board review decision
// of APPROVE is reached or during PR sync review lane processing.

import { and, eq } from "drizzle-orm";
import { issueWorkProducts, issues, type Db } from "@myrmidon/db";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { gitHubApiBase } from "./github-fetch.js";
import { logger } from "../middleware/logger.js";

export const REVIEW_APPROVED_LABEL = "review-approved";

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
): boolean {
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

/** Extracts head sha from text (e.g. `head 1234567`). */
export function parseReviewedHead(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = HEAD_SHA_PATTERN.exec(text);
  if (match?.[1]) return match[1];
  return null;
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
  submitReview(input: {
    repository: string;
    number: number;
    headSha: string;
    event: "APPROVE";
    body?: string;
    token: string;
  }): Promise<{ id?: number | string; skipped?: boolean }>;
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
  };
}

export async function resolveGitHubTokenForApproval(
  db: Db,
  companyId: string,
  repository?: string,
): Promise<string | null> {
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

  // Attempt shared GitHub App identity token if repository is provided
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
}

export interface PropagateReviewApprovalDeps {
  db: Db;
  client?: GitHubApprovalClient;
  tokenProvider?: (companyId: string, repository?: string) => Promise<string | null>;
  retryOptions?: RetryOptions;
}

/**
 * Propagate board review approval to a linked GitHub pull request.
 */
export async function propagateReviewApprovalToPullRequest(
  deps: PropagateReviewApprovalDeps,
  input: PropagateReviewApprovalInput,
): Promise<PropagateReviewApprovalResult> {
  const client = deps.client ?? createDefaultGitHubApprovalClient();
  const tokenProvider = deps.tokenProvider ?? ((c, r) => resolveGitHubTokenForApproval(deps.db, c, r));

  // Requirement 3: Negative path verification
  if (input.decisionOutcome && !isApprovalOutcome(input.decisionOutcome, input.verdictBody)) {
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
          decisionOutcome: input.decisionOutcome,
        },
      }).catch(() => {});
    }
    return { success: false, action: "skipped", reason: "non_approval" };
  }

  // Determine target PR coordinates and reviewed head
  let targetRepo = input.repository ?? null;
  let targetNumber = input.number ?? null;
  let reviewedHead = input.reviewedHeadSha ?? parseReviewedHead(input.verdictBody) ?? input.headSha ?? null;

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

  // Fall back to parsing PR from verdictBody or issue description
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
    const parsed = parsePullRequestCoordinates(contextText, targetRepo);
    if (parsed) {
      targetRepo = parsed.repository;
      targetNumber = parsed.number;
    }
  }

  if (!targetRepo || !targetNumber) {
    return { success: false, action: "skipped", reason: "no_linked_pr" };
  }

  // Requirement 5: Authorization check
  const token = await tokenProvider(input.companyId, targetRepo);
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

  // Requirement 2: Current-head guard
  if (reviewedHead && !headMatches(reviewedHead, prDetails.headSha)) {
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
          reason: "head_mismatch",
        },
      }).catch(() => {});
    }
    return {
      success: false,
      action: "skipped",
      reason: "head_mismatch",
      repository: targetRepo,
      pullRequestNumber: targetNumber,
      currentHeadSha: prDetails.headSha,
      reviewedHeadSha: reviewedHead,
    };
  }

  // Requirement 4: Idempotency
  const alreadyLabeled = prDetails.labels.includes(REVIEW_APPROVED_LABEL);

  // If already tagged with review-approved: no-op
  if (alreadyLabeled) {
    return {
      success: true,
      action: "noop",
      reason: "already_labeled",
      repository: targetRepo,
      pullRequestNumber: targetNumber,
      currentHeadSha: prDetails.headSha,
      reviewedHeadSha: reviewedHead ?? prDetails.headSha,
    };
  }

  // Requirement 1: Tag with review-approved and/or submit approving PR review
  let labelAdded = false;
  try {
    await executeWithRetry(
      () => client.addLabel({ repository: targetRepo!, number: targetNumber!, label: REVIEW_APPROVED_LABEL, token }),
      deps.retryOptions,
    );
    labelAdded = true;
  } catch (err) {
    logger.warn({ err, repository: targetRepo, number: targetNumber }, "failed to add review-approved label to PR");
  }

  let reviewSubmitted = false;
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
  };
}

/** Convenience wrapper that uses default dependencies for immediate invocation. */
export async function triggerReviewApprovalPropagation(
  db: Db,
  input: PropagateReviewApprovalInput,
): Promise<PropagateReviewApprovalResult> {
  return propagateReviewApprovalToPullRequest({ db }, input);
}
