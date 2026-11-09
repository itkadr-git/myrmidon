// server/src/modules/issues/adapters/postgres.ts
//
// myrmidon(1.7 POST-TASK-REFLECT, OPE-12095): Postgres / Drizzle ORM adapter
// for ReflectJobRepository.

import type { Db } from "@myrmidon/db";
import {
  reflectJobs,
  type NewReflectJobRow,
  type ReflectJobRow,
} from "@myrmidon/db";
import { eq } from "drizzle-orm";
import type {
  EnqueueReflectJobResult,
  ReflectJobRepository,
} from "../application/ports.js";
import type {
  NewReflectJobInput,
  ReflectJob,
  ReflectJobStatus,
} from "../domain/reflect-job.js";

export function mapRowToReflectJob(row: ReflectJobRow): ReflectJob {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    jobType: row.jobType,
    status: row.status as ReflectJobStatus,
    dedupKey: row.dedupKey,
    event: row.event,
    role: row.role ?? null,
    assigneeAgentId: row.assigneeAgentId ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
}

export function createPostgresReflectJobRepository(db: Db | any): ReflectJobRepository {
  return {
    async enqueueReflectJob(input: NewReflectJobInput): Promise<EnqueueReflectJobResult> {
      const dedupKey = input.dedupKey ?? `${input.issueId}:${input.event ?? "done"}`;

      const insertValues: NewReflectJobRow = {
        companyId: input.companyId,
        issueId: input.issueId,
        jobType: input.jobType ?? "post_task_reflect",
        status: "pending",
        dedupKey,
        event: input.event ?? "done",
        role: input.role ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        payload: input.payload ?? {},
      };

      const inserted = await db
        .insert(reflectJobs)
        .values(insertValues)
        .onConflictDoNothing({ target: reflectJobs.dedupKey })
        .returning();

      if (inserted.length > 0 && inserted[0]) {
        return {
          job: mapRowToReflectJob(inserted[0]),
          alreadyExisted: false,
        };
      }

      // Conflict occurred: fetch the existing row by dedupKey
      const existing = await db
        .select()
        .from(reflectJobs)
        .where(eq(reflectJobs.dedupKey, dedupKey))
        .limit(1);

      if (existing.length > 0 && existing[0]) {
        return {
          job: mapRowToReflectJob(existing[0]),
          alreadyExisted: true,
        };
      }

      throw new Error(`Failed to insert or find existing reflect job for dedupKey: ${dedupKey}`);
    },

    async updateJobStatus(
      id: string,
      status: ReflectJobStatus,
      options?: { error?: string | null; startedAt?: Date; finishedAt?: Date },
    ): Promise<ReflectJob | null> {
      const updateData: Partial<NewReflectJobRow> = {
        status,
        updatedAt: new Date(),
      };

      if (options?.error !== undefined) {
        updateData.error = options.error;
      }
      if (options?.startedAt !== undefined) {
        updateData.startedAt = options.startedAt;
      }
      if (options?.finishedAt !== undefined) {
        updateData.finishedAt = options.finishedAt;
      }

      const updated = await db
        .update(reflectJobs)
        .set(updateData)
        .where(eq(reflectJobs.id, id))
        .returning();

      return updated[0] ? mapRowToReflectJob(updated[0]) : null;
    },

    async findReflectJobById(id: string): Promise<ReflectJob | null> {
      const rows = await db
        .select()
        .from(reflectJobs)
        .where(eq(reflectJobs.id, id))
        .limit(1);

      return rows[0] ? mapRowToReflectJob(rows[0]) : null;
    },

    async findReflectJobByDedupKey(dedupKey: string): Promise<ReflectJob | null> {
      const rows = await db
        .select()
        .from(reflectJobs)
        .where(eq(reflectJobs.dedupKey, dedupKey))
        .limit(1);

      return rows[0] ? mapRowToReflectJob(rows[0]) : null;
    },

    async findReflectJobsByIssueId(issueId: string): Promise<ReflectJob[]> {
      const rows = await db
        .select()
        .from(reflectJobs)
        .where(eq(reflectJobs.issueId, issueId));

      return rows.map(mapRowToReflectJob);
    },

    async listPendingReflectJobs(limit: number = 50): Promise<ReflectJob[]> {
      const rows = await db
        .select()
        .from(reflectJobs)
        .where(eq(reflectJobs.status, "pending"))
        .limit(limit);

      return rows.map(mapRowToReflectJob);
    },
  };
}
