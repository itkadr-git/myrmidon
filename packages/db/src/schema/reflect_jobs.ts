// packages/db/src/schema/reflect_jobs.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): outbox queue for post-task-reflect jobs.
// When an issue transitions to "done", a job is enqueued here for asynchronous
// processing by the reflection service.
//
// Acceptance criteria:
// - Перевод задачи в done ставит задачу reflect в очередь (таблица/модель reflect_jobs);
// - повторный done не дублирует (dedup_key unique index);
// - hook on status change in packages/server/src/modules/issues.

import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const REFLECT_JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ReflectJobStatus = (typeof REFLECT_JOB_STATUSES)[number];

export const REFLECT_JOB_TYPES = ["post_task_reflect"] as const;
export type ReflectJobType = (typeof REFLECT_JOB_TYPES)[number];

export const reflectJobs = pgTable(
  "reflect_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull().default("post_task_reflect"),
    status: text("status").notNull().default("pending"),
    dedupKey: text("dedup_key").notNull(),
    event: text("event").notNull().default("done"),
    role: text("role"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("reflect_jobs_company_idx").on(table.companyId),
    issueIdx: index("reflect_jobs_issue_idx").on(table.issueId),
    statusIdx: index("reflect_jobs_status_idx").on(table.status),
    dedupKeyUniq: uniqueIndex("reflect_jobs_dedup_key_uniq").on(table.dedupKey),
  }),
);

export type ReflectJobRow = typeof reflectJobs.$inferSelect;
export type NewReflectJobRow = typeof reflectJobs.$inferInsert;
