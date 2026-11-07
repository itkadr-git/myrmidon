// server/src/modules/issues/application/ports.ts
//
// myrmidon(1.7 POST-TASK-REFLECT, OPE-12095): repository ports and event types
// for post-task-reflect job management.

import type { NewReflectJobInput, ReflectJob, ReflectJobStatus } from "../domain/reflect-job.js";

export interface EnqueueReflectJobResult {
  job: ReflectJob;
  alreadyExisted: boolean;
}

export interface ReflectJobWriter {
  enqueueReflectJob(input: NewReflectJobInput): Promise<EnqueueReflectJobResult>;
  updateJobStatus(
    id: string,
    status: ReflectJobStatus,
    options?: { error?: string | null; startedAt?: Date; finishedAt?: Date },
  ): Promise<ReflectJob | null>;
}

export interface ReflectJobReader {
  findReflectJobById(id: string): Promise<ReflectJob | null>;
  findReflectJobByDedupKey(dedupKey: string): Promise<ReflectJob | null>;
  findReflectJobsByIssueId(issueId: string): Promise<ReflectJob[]>;
  listPendingReflectJobs(limit?: number): Promise<ReflectJob[]>;
}

export type ReflectJobRepository = ReflectJobWriter & ReflectJobReader;

export interface IssueStatusChangeEvent {
  companyId: string;
  issueId: string;
  fromStatus?: string | null;
  toStatus: string;
  assigneeAgentId?: string | null;
  role?: string | null;
  payload?: Record<string, unknown>;
}

export interface StatusChangeHookResult {
  handled: boolean;
  enqueued: boolean;
  reason?: string;
  job?: ReflectJob;
  error?: Error;
}

export interface ModuleLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info?(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
}
