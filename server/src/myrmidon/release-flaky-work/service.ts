// server/src/myrmidon/release-flaky-work/service.ts
//
// myrmidon(1.8 RELEASE-STAGE): flaky CI work release gate service (OPE-13066).
// Manages state for flaky jobs, retries, evidence-backed waivers, and gate resumption.

import crypto from "node:crypto";
import type { Db } from "@myrmidon/db";
import {
  canResumeReleaseGate,
  validateFlakyEvidence,
  type ReleaseFlakyEvidence,
  type ReleaseFlakyGateState,
  type ReleaseFlakyJob,
  type ReleaseFlakyWaiver,
} from "@myrmidon/shared";
import { badRequest, conflict, notFound } from "../../errors.js";

export interface ReleaseFlakyActor {
  type: "agent" | "board" | "user";
  id: string;
  casteKey?: string;
}

export class ReleaseFlakyWorkService {
  private states = new Map<string, ReleaseFlakyGateState>();

  constructor(private readonly _db?: Db) {}

  public getOrCreateState(releaseId: string): ReleaseFlakyGateState {
    const existing = this.states.get(releaseId);
    if (existing) {
      return existing;
    }
    const initial: ReleaseFlakyGateState = {
      releaseId,
      gateStatus: "passed",
      canResume: true,
      jobs: [],
      waivers: [],
      resumedAt: null,
      resumedBy: null,
    };
    this.states.set(releaseId, initial);
    return initial;
  }

  public reportFailedJob(
    releaseId: string,
    params: {
      jobName: string;
      headSha: string;
      attempt: number;
      failureDetail?: string;
    },
  ): ReleaseFlakyGateState {
    const state = this.getOrCreateState(releaseId);
    const existingJobIndex = state.jobs.findIndex(
      (j) => j.jobName === params.jobName && j.headSha === params.headSha,
    );

    const jobData: ReleaseFlakyJob = {
      id:
        existingJobIndex >= 0
          ? state.jobs[existingJobIndex].id
          : `flaky-${crypto.randomUUID().slice(0, 8)}`,
      jobName: params.jobName,
      headSha: params.headSha,
      attempt: params.attempt,
      status: "failed",
      failureDetail: params.failureDetail,
    };

    if (existingJobIndex >= 0) {
      state.jobs[existingJobIndex] = jobData;
    } else {
      state.jobs.push(jobData);
    }

    this.recomputeGateState(state);
    return state;
  }

  public async retryJob(
    releaseId: string,
    jobId: string,
    outcome: "success" | "failed" = "success",
  ): Promise<ReleaseFlakyGateState> {
    const state = this.getOrCreateState(releaseId);
    const job = state.jobs.find((j) => j.id === jobId || j.jobName === jobId);
    if (!job) {
      throw notFound(`Flaky CI job "${jobId}" not found for release ${releaseId}`);
    }

    job.attempt += 1;
    job.retriedAt = new Date().toISOString();
    job.status = outcome === "success" ? "success" : "failed";
    if (outcome === "success") {
      job.resolvedAt = new Date().toISOString();
      job.failureDetail = undefined;
    }

    this.recomputeGateState(state);
    return state;
  }

  public recordWaiver(
    releaseId: string,
    params: {
      job: string;
      reason: string;
      evidence: ReleaseFlakyEvidence;
    },
    actor: ReleaseFlakyActor,
  ): ReleaseFlakyGateState {
    const state = this.getOrCreateState(releaseId);

    // 1. Evidence contract validation
    const evidenceRes = validateFlakyEvidence(params.evidence);
    if (!evidenceRes.valid || !evidenceRes.evidence) {
      throw badRequest(evidenceRes.error ?? "Invalid waiver evidence");
    }
    const evidence = evidenceRes.evidence;

    // 2. Target job verification: must exist and match headSha, job name, attempt
    const targetJob = state.jobs.find(
      (j) => j.jobName === params.job || j.id === params.job,
    );
    if (!targetJob) {
      throw notFound(`Target flaky CI job "${params.job}" not found in release ${releaseId}`);
    }

    if (evidence.job !== targetJob.jobName) {
      throw badRequest(
        `Waiver evidence job name "${evidence.job}" does not match target job "${targetJob.jobName}"`,
      );
    }
    if (evidence.headSha !== targetJob.headSha) {
      throw badRequest(
        `Waiver evidence headSha "${evidence.headSha}" does not match target job "${targetJob.headSha}"`,
      );
    }
    if (evidence.attempt !== targetJob.attempt) {
      throw badRequest(
        `Waiver evidence attempt ${evidence.attempt} does not match target job attempt ${targetJob.attempt}`,
      );
    }

    const waiver: ReleaseFlakyWaiver = {
      job: targetJob.jobName,
      reason: params.reason,
      evidence,
      actor,
      waivedAt: new Date().toISOString(),
    };

    targetJob.status = "waived";
    targetJob.resolvedAt = new Date().toISOString();
    state.waivers.push(waiver);

    this.recomputeGateState(state);
    return state;
  }

  public resumeGate(releaseId: string, actor: ReleaseFlakyActor): ReleaseFlakyGateState {
    const state = this.getOrCreateState(releaseId);
    const decision = canResumeReleaseGate(state.jobs, state.waivers);

    if (!decision.canResume) {
      throw conflict(
        decision.blockingReason ??
          `Release gate blocked: unresolved flaky jobs exist (${decision.unresolvedJobs.join(", ")})`,
      );
    }

    state.gateStatus = "resumed";
    state.canResume = true;
    state.blockingReason = undefined;
    state.resumedAt = new Date().toISOString();
    state.resumedBy = actor;

    return state;
  }

  private recomputeGateState(state: ReleaseFlakyGateState): void {
    const decision = canResumeReleaseGate(state.jobs, state.waivers);
    state.canResume = decision.canResume;
    state.blockingReason = decision.blockingReason;
    if (!decision.canResume) {
      state.gateStatus = "blocked";
    } else if (state.gateStatus === "blocked") {
      // If was blocked, but now all jobs are green/waived, gate can be resumed or passes
      state.gateStatus = "resumed";
    }
  }
}
