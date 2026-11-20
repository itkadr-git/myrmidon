import { pgTable, uuid, text, timestamp, jsonb, bigint, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentRuntimeState = pgTable(
  "agent_runtime_state",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    adapterType: text("adapter_type").notNull(),
    sessionId: text("session_id"),
    stateJson: jsonb("state_json").$type<Record<string, unknown>>().notNull().default({}),
    lastRunId: uuid("last_run_id"),
    lastRunStatus: text("last_run_status"),
    totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull().default(0),
    totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull().default(0),
    totalCachedInputTokens: bigint("total_cached_input_tokens", { mode: "number" }).notNull().default(0),
    totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    // myrmidon(OPE-13021): response-probe liveness. lastResponseAt is the last
    // time the model actually produced work (tokens spent or a model response
    // started); lastProbeAt/lastProbeOutcome record the process probe
    // (gateway health check). Nullable: null = never probed / never answered.
    lastResponseAt: timestamp("last_response_at", { withTimezone: true }),
    lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
    lastProbeOutcome: text("last_probe_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_runtime_state_company_agent_idx").on(table.companyId, table.agentId),
    companyUpdatedIdx: index("agent_runtime_state_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);
