// server/src/modules/issues/application/queue-reflect-job.test.ts

import { describe, expect, it } from "vitest";
import type {
  EnqueueReflectJobResult,
  IssueStatusChangeEvent,
  ReflectJobRepository,
} from "./ports.js";
import { handleIssueStatusChange } from "./queue-reflect-job.js";
import type { NewReflectJobInput, ReflectJob } from "../domain/reflect-job.js";

function createMockRepository(): {
  repo: ReflectJobRepository;
  jobs: Map<string, ReflectJob>;
  calls: NewReflectJobInput[];
} {
  const jobs = new Map<string, ReflectJob>();
  const calls: NewReflectJobInput[] = [];

  const repo: ReflectJobRepository = {
    async enqueueReflectJob(input: NewReflectJobInput): Promise<EnqueueReflectJobResult> {
      calls.push(input);
      const dedupKey = input.dedupKey ?? `${input.issueId}:${input.event ?? "done"}`;
      const existing = jobs.get(dedupKey);
      if (existing) {
        return { job: existing, alreadyExisted: true };
      }

      const now = new Date();
      const job: ReflectJob = {
        id: `job-${jobs.size + 1}`,
        companyId: input.companyId,
        issueId: input.issueId,
        jobType: input.jobType ?? "post_task_reflect",
        status: "pending",
        dedupKey,
        event: input.event ?? "done",
        role: input.role ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        payload: input.payload ?? {},
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };

      jobs.set(dedupKey, job);
      return { job, alreadyExisted: false };
    },

    async updateJobStatus(id, status, options) {
      for (const [key, job] of jobs.entries()) {
        if (job.id === id) {
          const updated: ReflectJob = {
            ...job,
            status,
            error: options?.error ?? job.error,
            startedAt: options?.startedAt ?? job.startedAt,
            finishedAt: options?.finishedAt ?? job.finishedAt,
            updatedAt: new Date(),
          };
          jobs.set(key, updated);
          return updated;
        }
      }
      return null;
    },

    async findReflectJobById(id) {
      for (const job of jobs.values()) {
        if (job.id === id) return job;
      }
      return null;
    },

    async findReflectJobByDedupKey(dedupKey) {
      return jobs.get(dedupKey) ?? null;
    },

    async findReflectJobsByIssueId(issueId) {
      return Array.from(jobs.values()).filter((j) => j.issueId === issueId);
    },

    async listPendingReflectJobs() {
      return Array.from(jobs.values()).filter((j) => j.status === "pending");
    },
  };

  return { repo, jobs, calls };
}

describe("handleIssueStatusChange use case", () => {
  it("enqueues a reflect job when issue transitions to done", async () => {
    const { repo, calls } = createMockRepository();

    const event: IssueStatusChangeEvent = {
      companyId: "comp-1",
      issueId: "issue-100",
      fromStatus: "in_progress",
      toStatus: "done",
      assigneeAgentId: "agent-1",
      role: "engineer",
      payload: { comment: "Completed task" },
    };

    const result = await handleIssueStatusChange(event, { repository: repo });

    expect(result.handled).toBe(true);
    expect(result.enqueued).toBe(true);
    expect(result.job).toBeDefined();
    expect(result.job?.issueId).toBe("issue-100");
    expect(result.job?.companyId).toBe("comp-1");
    expect(result.job?.status).toBe("pending");
    expect(result.job?.dedupKey).toBe("issue-100:done");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.dedupKey).toBe("issue-100:done");
  });

  it("does not duplicate when transitioning to done again (repeat done)", async () => {
    const { repo, calls } = createMockRepository();

    // 1. Initial transition to done
    const firstEvent: IssueStatusChangeEvent = {
      companyId: "comp-1",
      issueId: "issue-200",
      fromStatus: "in_review",
      toStatus: "done",
    };
    const firstResult = await handleIssueStatusChange(firstEvent, { repository: repo });
    expect(firstResult.enqueued).toBe(true);
    expect(calls).toHaveLength(1);

    // 2. Second event with fromStatus: "done" and toStatus: "done"
    const repeatEvent: IssueStatusChangeEvent = {
      companyId: "comp-1",
      issueId: "issue-200",
      fromStatus: "done",
      toStatus: "done",
    };
    const secondResult = await handleIssueStatusChange(repeatEvent, { repository: repo });
    expect(secondResult.handled).toBe(true);
    expect(secondResult.enqueued).toBe(false);
    expect(secondResult.reason).toBe("already_done");
    // Repository was not called a second time
    expect(calls).toHaveLength(1);
  });

  it("does not duplicate if repository already has existing dedupKey", async () => {
    const { repo, calls } = createMockRepository();

    const event1: IssueStatusChangeEvent = {
      companyId: "comp-1",
      issueId: "issue-300",
      fromStatus: "in_progress",
      toStatus: "done",
    };
    const res1 = await handleIssueStatusChange(event1, { repository: repo });
    expect(res1.enqueued).toBe(true);

    // Simulate concurrent or retry event where fromStatus was not "done" but job already exists
    const event2: IssueStatusChangeEvent = {
      companyId: "comp-1",
      issueId: "issue-300",
      fromStatus: "todo",
      toStatus: "done",
    };
    const res2 = await handleIssueStatusChange(event2, { repository: repo });
    expect(res2.handled).toBe(true);
    expect(res2.enqueued).toBe(false);
    expect(res2.reason).toBe("duplicate_dedup_key");
    expect(res2.job?.id).toBe(res1.job?.id);
  });

  it("does not enqueue when toStatus is not done", async () => {
    const { repo, calls } = createMockRepository();

    const event: IssueStatusChangeEvent = {
      companyId: "comp-1",
      issueId: "issue-400",
      fromStatus: "todo",
      toStatus: "in_progress",
    };

    const result = await handleIssueStatusChange(event, { repository: repo });

    expect(result.handled).toBe(true);
    expect(result.enqueued).toBe(false);
    expect(result.reason).toBe("status_not_done");
    expect(calls).toHaveLength(0);
  });

  it("catches repository errors gracefully without throwing", async () => {
    const failingRepo: ReflectJobRepository = {
      async enqueueReflectJob() {
        throw new Error("Database connection lost");
      },
      async updateJobStatus() {
        return null;
      },
      async findReflectJobById() {
        return null;
      },
      async findReflectJobByDedupKey() {
        return null;
      },
      async findReflectJobsByIssueId() {
        return [];
      },
      async listPendingReflectJobs() {
        return [];
      },
    };

    const event: IssueStatusChangeEvent = {
      companyId: "comp-1",
      issueId: "issue-500",
      fromStatus: "in_progress",
      toStatus: "done",
    };

    const result = await handleIssueStatusChange(event, { repository: failingRepo });

    expect(result.handled).toBe(false);
    expect(result.enqueued).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toBe("Database connection lost");
  });
});
