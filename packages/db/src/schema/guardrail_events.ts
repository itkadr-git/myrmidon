import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";

/**
 * myrmidon(1.6-GRD): one guardrail flagging event, company-scoped.
 *
 * The 1.6.1 guardrail layer is flag-only: a row says a detector fired on a
 * run's output surface. The stored `snippet` is cut from text that already
 * went through value masking (S5) and shape redaction (typed
 * [REDACTED:<subtype>] placeholders), so no raw secret or personal datum is
 * persisted here. Deleting a company drops its events; deleting a run keeps
 * the event with a null run_id. Legal-entity requisites are a separate backlog item
 * and never appear.
 */
export const guardrailEvents = pgTable(
  "guardrail_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    surface: text("surface").notNull(),
    severity: text("severity").notNull(),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id"),
    /** Masked excerpt; the plain text itself is never stored. */
    snippet: text("snippet"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** myrmidon(1.6.6 GUARDRAILS J.1, OPE-9649): enforcement context — which rule
     * fired, in which mode, at which level, for which agent, with what decision. */
    rule: text("rule"),
    mode: text("mode"),
    level: text("level"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    decision: text("decision"),
  },
  (table) => ({
    companyOccurredIdx: index("guardrail_events_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    runIdx: index("guardrail_events_run_id_idx").on(table.runId),
    agentIdx: index("guardrail_events_agent_id_idx").on(table.agentId),
    ruleIdx: index("guardrail_events_rule_idx").on(table.rule),
  }),
);
