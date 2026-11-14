// ui/src/api/releaseFlakyWork.ts
//
// myrmidon(1.8 RELEASE-STAGE): API client for flaky CI work & release gate (OPE-13066).

import { api } from "./client";
import type {
  ReleaseFlakyEvidence,
  ReleaseFlakyGateState,
} from "@myrmidon/shared";

export interface ReportFlakyJobParams {
  jobName: string;
  headSha: string;
  attempt: number;
  failureDetail?: string;
}

export interface RetryFlakyJobParams {
  jobId: string;
}

export interface RetryFlakyResultParams {
  jobId: string;
  headSha: string;
  attempt: number;
  outcome: "success" | "failed";
  runId?: string;
  url?: string;
  failureDetail?: string;
}

export interface RecordFlakyWaiverParams {
  job: string;
  reason: string;
  evidence: ReleaseFlakyEvidence;
}

export const releaseFlakyWorkApi = {
  getGateState(releaseId: string): Promise<ReleaseFlakyGateState> {
    return api.get<ReleaseFlakyGateState>(`/myrmidon/release-stages/${releaseId}/flaky-work`);
  },

  reportFailedJob(
    releaseId: string,
    params: ReportFlakyJobParams,
  ): Promise<ReleaseFlakyGateState> {
    return api.post<ReleaseFlakyGateState>(
      `/myrmidon/release-stages/${releaseId}/flaky-work/jobs`,
      params,
    );
  },

  retryJob(
    releaseId: string,
    params: RetryFlakyJobParams,
  ): Promise<ReleaseFlakyGateState> {
    return api.post<ReleaseFlakyGateState>(
      `/myrmidon/release-stages/${releaseId}/flaky-work/retry`,
      params,
    );
  },

  recordRetryResult(
    releaseId: string,
    params: RetryFlakyResultParams,
  ): Promise<ReleaseFlakyGateState> {
    return api.post<ReleaseFlakyGateState>(
      `/myrmidon/release-stages/${releaseId}/flaky-work/retry-result`,
      params,
    );
  },

  recordWaiver(
    releaseId: string,
    params: RecordFlakyWaiverParams,
  ): Promise<ReleaseFlakyGateState> {
    return api.post<ReleaseFlakyGateState>(
      `/myrmidon/release-stages/${releaseId}/flaky-work/waiver`,
      params,
    );
  },

  resumeGate(releaseId: string): Promise<ReleaseFlakyGateState> {
    return api.post<ReleaseFlakyGateState>(
      `/myrmidon/release-stages/${releaseId}/flaky-work/resume`,
      {},
    );
  },
};
