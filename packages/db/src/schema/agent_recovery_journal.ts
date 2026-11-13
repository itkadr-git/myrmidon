import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// myrmidon(1.8 AGENT-LIVENESS C2, OPE-13023): one recovery-journal row per
// observed agent-liveness step. Append-only: a correction is a NEW row, never
// an UPDATE (the same ONCE-semantics rule as the heartbeat run events). A row
// with `suppressed_reason` set records that the step was observed but its
// action was suppressed ("exclusion_window": inside a maintenance or caller
// supplied exclusion window). Dedup within the configured window is enforced
// by the service in its transaction; the (dedup_key, created_at) index keeps
// that check a point lookup.
export const agentRecoveryJournal = pgTable(
  "agent_recovery_journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    /** Which liveness step wrote the row (probe, queue_without_run, retry, resurrection, ladder). */
    step: text("step").notNull(),
    /** Why the step fired: a short cause code chosen by the caller. */
    cause: text("cause").notNull(),
    /** Dedup key: the same key is not appended twice inside the dedup window. */
    dedupKey: text("dedup_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Why the step's action was suppressed; null when the action ran. */
    suppressedReason: text("suppressed_reason"),
  },
  (table) => [
    // Journal listing for one company+agent (newest first) — the API route.
    index("agent_recovery_journal_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    index("agent_recovery_journal_agent_created_idx").on(table.agentId, table.createdAt),
    index("agent_recovery_journal_company_created_idx").on(table.companyId, table.createdAt),
    // Dedup check: newest row with the key inside the window.
    index("agent_recovery_journal_dedup_key_created_idx").on(table.dedupKey, table.createdAt),
    // Retention sweep: delete rows older than the retention constant.
    index("agent_recovery_journal_created_idx").on(table.createdAt),
  ],
);
