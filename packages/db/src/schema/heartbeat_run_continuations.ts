import { index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  ExecutionContinuationEnvelope,
  ExecutionContinuationWakeLinks,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * myrmidon(DB-CARE DBC-3): the execution-continuation envelope of one run.
 *
 * The envelope used to travel inside `heartbeat_runs.context_snapshot`, where it
 * copied the whole task history next to the wake payload. The database audit of
 * 08.10.2026 measured 31 KB average per snapshot and this column dominated the
 * table's TOAST traffic. The envelope now lives here, one row per run, with the
 * wake payload referenced by id (`wake_links`) instead of copied twice.
 *
 * Readers fall back to the legacy `context_snapshot.executionContinuation` copy
 * for runs written before this table exists, so resume keeps working across the
 * deployment. `envelope` is bounded: messages are capped by characters and
 * `completedActions` only carries the previous context run
 * (see `server/src/myrmidon/continuation-history-limit.ts`).
 */
export const heartbeatRunContinuations = pgTable(
  "heartbeat_run_continuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id"),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    previousContextRunId: uuid("previous_context_run_id"),
    envelope: jsonb("envelope").$type<ExecutionContinuationEnvelope>().notNull(),
    /** Serialized size of `envelope`, so the audit can watch the cap hold. */
    envelopeChars: integer("envelope_chars").notNull(),
    wakeLinks: jsonb("wake_links").$type<ExecutionContinuationWakeLinks>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("heartbeat_run_continuations_run_uq").on(table.runId),
    index("heartbeat_run_continuations_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    index("heartbeat_run_continuations_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  ],
);