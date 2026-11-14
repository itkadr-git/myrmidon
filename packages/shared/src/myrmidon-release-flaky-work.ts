// packages/shared/src/myrmidon-release-flaky-work.ts
//
// myrmidon(1.8 RELEASE-STAGE): flaky CI work lifecycle — retry, evidence-backed
// waiver, and release gate resumption.
//
// Pure contracts and decisions:
//  1. Evidence validation: waivers MUST bind to headSha, job, and attempt.
//  2. Release gate evaluation: gate resumes only when every flaky job is green
//     (successful retry) or has an accepted, evidence-backed waiver.

import { z } from "zod";

export const FLAKY_JOB_STATUSES = ["failed", "retrying", "success", "waived"] as const;
export type FlakyJobStatus = (typeof FLAKY_JOB_STATUSES)[number];

export const FLAKY_GATE_STATUSES = ["blocked", "resumed", "passed"] as const;
export type FlakyGateStatus = (typeof FLAKY_GATE_STATUSES)[number];

export interface ReleaseFlakyEvidence {
  headSha: string;
  job: string;
  attempt: number;
  runId?: string;
  url?: string;
  verifiedAt?: string;
}

export interface ReleaseFlakyJob {
  id: string;
  jobName: string;
  headSha: string;
  attempt: number;
  status: FlakyJobStatus;
  failureDetail?: string;
  retriedAt?: string;
  resolvedAt?: string;
}

export interface ReleaseFlakyWaiver {
  job: string;
  reason: string;
  evidence: ReleaseFlakyEvidence;
  actor: {
    type: "agent" | "board" | "user";
    id: string;
    casteKey?: string;
  };
  waivedAt: string;
}

export interface ReleaseFlakyGateState {
  releaseId: string;
  gateStatus: FlakyGateStatus;
  canResume: boolean;
  blockingReason?: string;
  jobs: ReleaseFlakyJob[];
  waivers: ReleaseFlakyWaiver[];
  resumedAt?: string | null;
  resumedBy?: {
    type: "agent" | "board" | "user";
    id: string;
    casteKey?: string;
  } | null;
}

export const releaseFlakyEvidenceSchema = z.object({
  headSha: z.string().trim().min(1, "headSha is required").max(128),
  job: z.string().trim().min(1, "job name is required").max(256),
  attempt: z.number().int().min(1, "attempt must be an integer >= 1"),
  runId: z.string().trim().max(128).optional(),
  url: z.string().url().max(2000).optional(),
  verifiedAt: z.string().datetime().optional(),
});

export const releaseFlakyJobSchema = z.object({
  id: z.string().min(1),
  jobName: z.string().min(1).max(256),
  headSha: z.string().min(1).max(128),
  attempt: z.number().int().min(1),
  status: z.enum(FLAKY_JOB_STATUSES),
  failureDetail: z.string().max(2000).optional(),
  retriedAt: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
});

export const releaseFlakyWaiverSchema = z.object({
  job: z.string().min(1).max(256),
  reason: z.string().trim().min(1, "reason is required").max(1000),
  evidence: releaseFlakyEvidenceSchema,
  actor: z.object({
    type: z.enum(["agent", "board", "user"]),
    id: z.string().min(1),
    casteKey: z.string().optional(),
  }),
  waivedAt: z.string().datetime(),
});

export interface EvidenceValidationResult {
  valid: boolean;
  error?: string;
  evidence?: ReleaseFlakyEvidence;
}

/**
 * Validates that waiver evidence strictly carries headSha, job name, and attempt >= 1.
 */
export function validateFlakyEvidence(input: unknown): EvidenceValidationResult {
  const parsed = releaseFlakyEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return {
      valid: false,
      error: `Invalid flaky evidence: ${errorMsg}`,
    };
  }
  return {
    valid: true,
    evidence: parsed.data,
  };
}

export interface GateResumeDecision {
  canResume: boolean;
  blockingReason?: string;
  unresolvedJobs: string[];
}

/**
 * Pure decision: can the release gate continue / resume?
 * The gate resumes when all jobs have either a green retry (status "success")
 * or a valid evidence-backed waiver matching headSha, job name, and attempt.
 */
export function canResumeReleaseGate(
  jobs: readonly ReleaseFlakyJob[],
  waivers: readonly ReleaseFlakyWaiver[],
): GateResumeDecision {
  if (jobs.length === 0) {
    return { canResume: true, unresolvedJobs: [] };
  }

  const unresolvedJobs: string[] = [];

  for (const job of jobs) {
    if (job.status === "success") {
      continue;
    }
    const hasValidWaiver = waivers.some((w) => {
      const e = w.evidence;
      return (
        w.job === job.jobName &&
        e.job === job.jobName &&
        e.headSha === job.headSha &&
        e.attempt === job.attempt
      );
    });
    if (job.status === "waived" || hasValidWaiver) {
      continue;
    }
    unresolvedJobs.push(job.jobName);
  }

  if (unresolvedJobs.length > 0) {
    return {
      canResume: false,
      blockingReason: `Release gate blocked on unresolved flaky CI job(s): ${unresolvedJobs.join(", ")}`,
      unresolvedJobs,
    };
  }

  return {
    canResume: true,
    unresolvedJobs: [],
  };
}
