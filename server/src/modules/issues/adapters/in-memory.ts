// server/src/modules/issues/adapters/in-memory.ts
//
// myrmidon(1.7 POST-TASK-REFLECT, OPE-12095): in-memory adapter for ReflectJobRepository.
// Useful for tests, local execution, and fallback scenarios.

import type {
  EnqueueReflectJobResult,
  ReflectJobRepository,
} from "../application/ports.js";
import type {
  NewReflectJobInput,
  ReflectJob,
  ReflectJobStatus,
} from "../domain/reflect-job.js";

export class InMemoryReflectJobRepository implements ReflectJobRepository {
  private readonly jobsByDedupKey = new Map<string, ReflectJob>();
  private readonly jobsById = new Map<string, ReflectJob>();
  private idCounter = 1;

  async enqueueReflectJob(input: NewReflectJobInput): Promise<EnqueueReflectJobResult> {
    const dedupKey = input.dedupKey ?? `${input.issueId}:${input.event ?? "done"}`;
    const existing = this.jobsByDedupKey.get(dedupKey);
    if (existing) {
      return { job: existing, alreadyExisted: true };
    }

    const id = `job-mem-${this.idCounter++}`;
    const now = new Date();
    const job: ReflectJob = {
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      jobType: input.jobType ?? "post_task_reflect",
      status: "pending",
      dedupKey,
      event: input.event ?? "done",
      role: input.role ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      payload: input.payload ? { ...input.payload } : {},
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };

    this.jobsByDedupKey.set(dedupKey, job);
    this.jobsById.set(id, job);
    return { job, alreadyExisted: false };
  }

  async updateJobStatus(
    id: string,
    status: ReflectJobStatus,
    options?: { error?: string | null; startedAt?: Date; finishedAt?: Date },
  ): Promise<ReflectJob | null> {
    const existing = this.jobsById.get(id);
    if (!existing) return null;

    const updated: ReflectJob = {
      ...existing,
      status,
      error: options?.error !== undefined ? options.error : existing.error,
      startedAt: options?.startedAt !== undefined ? options.startedAt : existing.startedAt,
      finishedAt: options?.finishedAt !== undefined ? options.finishedAt : existing.finishedAt,
      updatedAt: new Date(),
    };

    this.jobsById.set(id, updated);
    this.jobsByDedupKey.set(updated.dedupKey, updated);
    return updated;
  }

  async findReflectJobById(id: string): Promise<ReflectJob | null> {
    return this.jobsById.get(id) ?? null;
  }

  async findReflectJobByDedupKey(dedupKey: string): Promise<ReflectJob | null> {
    return this.jobsByDedupKey.get(dedupKey) ?? null;
  }

  async findReflectJobsByIssueId(issueId: string): Promise<ReflectJob[]> {
    return Array.from(this.jobsById.values()).filter((j) => j.issueId === issueId);
  }

  async listPendingReflectJobs(limit: number = 50): Promise<ReflectJob[]> {
    return Array.from(this.jobsById.values())
      .filter((j) => j.status === "pending")
      .slice(0, limit);
  }

  clear(): void {
    this.jobsByDedupKey.clear();
    this.jobsById.clear();
    this.idCounter = 1;
  }
}
