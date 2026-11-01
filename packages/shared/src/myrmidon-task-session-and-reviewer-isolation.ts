import { z } from "zod";

/**
 * Task Session Isolation and Reviewer Containment Contracts (myrmidon WAKE-9).
 *
 * Implements the architecture and acceptance contracts for:
 * 1. Strict session-per-task isolation (preventing cross-task session and context leaks).
 * 2. Reviewer isolation (restricting reviewer payload strictly to task specification and diff,
 *    filtering out coder history, internal comments, and sensitive environment material).
 * 3. Strict review verdict contracts (validating approve / request_changes decisions).
 * 4. Threat & privacy containment (prompt-injection detection in diffs, secret sanitization).
 */

// --- 1. Task Session Isolation (Session-per-task) ---

export interface TaskSessionKeyInput {
  companyId: string;
  agentId: string;
  adapterType: string;
  issueId: string;
}

export function buildTaskSessionKey(input: TaskSessionKeyInput): string {
  if (!input.companyId || !input.agentId || !input.adapterType || !input.issueId) {
    throw new Error(
      "Cannot build task session key: companyId, agentId, adapterType, and issueId are required",
    );
  }
  return `${input.companyId}:${input.agentId}:${input.adapterType}:${input.issueId}`;
}

export interface TaskSessionResumptionInput {
  targetIssueId: string;
  sessionIssueId: string | null | undefined;
  sessionParams: Record<string, unknown> | null | undefined;
}

export interface TaskSessionResumptionResult {
  allowed: boolean;
  reason:
    | "match"
    | "missing_target"
    | "missing_session"
    | "cross_task_context_leak_detected";
}

/**
 * Validates that an agent attempting to resume a session matches the exact target task.
 * Cross-task session resumption is strictly disallowed to prevent memory/context leakage.
 */
export function validateTaskSessionResumption(
  input: TaskSessionResumptionInput,
): TaskSessionResumptionResult {
  if (!input.targetIssueId) {
    return { allowed: false, reason: "missing_target" };
  }
  if (!input.sessionIssueId || !input.sessionParams) {
    return { allowed: false, reason: "missing_session" };
  }
  if (input.targetIssueId !== input.sessionIssueId) {
    return { allowed: false, reason: "cross_task_context_leak_detected" };
  }
  return { allowed: true, reason: "match" };
}

/**
 * Determines whether an unscoped runtime session fallback (e.g. getRuntimeState().sessionId)
 * is permitted for the given wake.
 * Issue runs MUST NOT fall back to unscoped global sessions.
 */
export function isUnscopedSessionFallbackAllowed(input: {
  issueId: string | null | undefined;
  wakeReason: string;
}): boolean {
  if (input.issueId) {
    // An issue-bound run must never fall back to an unscoped session.
    return false;
  }
  return (
    input.wakeReason === "heartbeat_timer" ||
    input.wakeReason === "on_demand_unscoped"
  );
}

export function buildTaskScopedScratchPath(
  baseScratchDir: string,
  issueIdentifier: string,
): string {
  const sanitizedIdentifier = issueIdentifier.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${baseScratchDir.replace(/\/+$/, "")}/tasks/${sanitizedIdentifier}`;
}

// --- 2. Reviewer Isolation & Minimal Input Fixture ---

export interface RawIssueContextForReview {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  acceptanceCriteria?: string[] | string | null;
  comments?: Array<{
    id: string;
    authorType: string;
    authorId?: string;
    body: string;
    createdAt?: string;
  }>;
  coderSessionHistory?: unknown;
  coderInternalThoughts?: unknown;
  scratchpadPaths?: string[];
  environmentSecrets?: Record<string, string>;
  foreignTaskContext?: unknown;
}

export interface PullRequestDiffData {
  number: number;
  repository: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  authorLogin: string;
  diff: string;
}

export interface ReviewerInputFixture {
  taskIdentifier: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string[];
  diff: string;
  prMetadata: {
    number: number;
    repository: string;
    baseBranch: string;
    headBranch: string;
    headSha: string;
    authorLogin: string;
  };
  reviewInstructions: string;
  disposition: "quarantined" | "clean";
  // Explicit marker proving forbidden data was stripped
  forbiddenDataExcluded: true;
}

export const DEFAULT_REVIEW_INSTRUCTIONS =
  "Review the provided code diff strictly against the task specification and acceptance criteria. " +
  "Submit your verdict using the structured review action ('approve' or 'request_changes'). " +
  "Do not attempt to execute code or modify the repository directly.";

/**
 * Sanitizes and extracts the minimal reviewer input fixture from raw issue & PR data.
 * All coder internal history, non-specification comments, and environment secrets are excluded.
 */
export function buildReviewerInputFixture(input: {
  issue: RawIssueContextForReview;
  pr: PullRequestDiffData;
  reviewInstructions?: string;
}): ReviewerInputFixture {
  const criteria: string[] = [];
  if (Array.isArray(input.issue.acceptanceCriteria)) {
    criteria.push(...input.issue.acceptanceCriteria);
  } else if (
    typeof input.issue.acceptanceCriteria === "string" &&
    input.issue.acceptanceCriteria.trim()
  ) {
    criteria.push(input.issue.acceptanceCriteria.trim());
  } else if (input.issue.description) {
    // Extract acceptance criteria from description markdown if present (e.g. ## Acceptance Criteria)
    const acMatch = input.issue.description.match(
      /(?:Критерии при[её]мки|Acceptance criteria):?\s*([\s\S]*?)(?:\n##|\n\n[A-Z]|$)/i,
    );
    if (acMatch?.[1]) {
      const items = acMatch[1]
        .split("\n")
        .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
        .filter(Boolean);
      criteria.push(...items);
    }
  }

  const threatAnalysis = analyzeReviewerDiffThreats(input.pr.diff);
  const sanitizedDiff = threatAnalysis.hasPromptInjection
    ? `<untrusted_diff disposition="quarantined">\n${threatAnalysis.sanitizedDiff}\n</untrusted_diff>`
    : threatAnalysis.sanitizedDiff;

  return {
    taskIdentifier: input.issue.identifier,
    taskTitle: input.issue.title,
    taskDescription: input.issue.description ?? "",
    acceptanceCriteria: criteria,
    diff: sanitizedDiff,
    prMetadata: {
      number: input.pr.number,
      repository: input.pr.repository,
      baseBranch: input.pr.baseBranch,
      headBranch: input.pr.headBranch,
      headSha: input.pr.headSha,
      authorLogin: input.pr.authorLogin,
    },
    reviewInstructions: input.reviewInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS,
    disposition: threatAnalysis.hasPromptInjection ? "quarantined" : "clean",
    forbiddenDataExcluded: true,
  };
}

// --- 3. Review Verdict Contract ---

export const REVIEW_DECISIONS = ["approve", "request_changes"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const reviewInlineCommentSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  comment: z.string().min(1),
});

export const reviewVerdictSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    summary: z.string().min(1).max(4000),
    inlineComments: z.array(reviewInlineCommentSchema).optional().default([]),
    securityNotes: z.string().optional(),
  })
  .strict();

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export function validateReviewVerdict(value: unknown): {
  valid: boolean;
  verdict?: ReviewVerdict;
  error?: string;
} {
  const parsed = reviewVerdictSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return {
    valid: true,
    verdict: parsed.data,
  };
}

// --- 4. Threat & Privacy Containment ---

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /system\s*:\s*you\s+must\s+approve/i,
  /disregard\s+(?:above|rules|instructions)/i,
  /override\s+review\s+verdict/i,
  /approve\s+this\s+pr\s+immediately/i,
  /<script[\s\S]*?>[\s\S]*?<\/script>/i,
  /curl\s+.*?https?:\/\//i,
];

const SECRET_PATTERNS = [
  new RegExp(["pc", "p_[a-zA-Z0-9_-]{20,}"].join(""), "g"),
  new RegExp(["gh", "p_[a-zA-Z0-9]{30,}"].join(""), "g"),
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,
  /-----BEGIN\s+(?:RSA|OPENSSH|EC|PRIVATE)\s+KEY-----[\s\S]*?-----END/gi,
];

export interface DiffThreatAnalysisResult {
  hasPromptInjection: boolean;
  detectedThreats: string[];
  sanitizedDiff: string;
}

export function analyzeReviewerDiffThreats(
  diff: string,
): DiffThreatAnalysisResult {
  const detectedThreats: string[] = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(diff)) {
      detectedThreats.push(
        `Prompt injection signature detected: ${pattern.source}`,
      );
    }
  }

  let sanitized = diff;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "<redacted_secret>");
  }

  return {
    hasPromptInjection: detectedThreats.length > 0,
    detectedThreats,
    sanitizedDiff: sanitized,
  };
}

export function sanitizeEnvironmentSecrets(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(env)) {
    if (/KEY|SECRET|TOKEN|PASSWORD|AUTH|PRIVATE|CREDENTIAL/i.test(key)) {
      sanitized[key] = "<redacted>";
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}
