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
 * 1.7 GUARDRAILS J.1 (OPE-9649): includes rule, mode, level, agent_id, decision.
 * The stored `snippet` is cut from text that already went through value masking
 * and shape redaction, so no raw secret or personal datum is persisted here.
 */
export const guardrailEvents = pgTable(
  "guardrail_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    rule: text("rule"),
    mode: text("mode"),
    level: text("level"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    decision: text("decision"),
    surface: text("surface").notNull(),
    severity: text("severity").notNull(),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id"),
    /** Masked excerpt; the plain text itself is never stored. */
    snippet: text("snippet"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
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
