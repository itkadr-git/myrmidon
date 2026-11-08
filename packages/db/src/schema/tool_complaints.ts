import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

// myrmidon(1.7 TOOL-COMPLAINTS-API, OPE-12228): the agent tool-complaint
// channel. An agent files a complaint about a tool (bad output, wrong
// schema, missing capability) so the operator fleet sees a per-company
// feed instead of scattered issue comments. Company-scoped: one company
// never sees another's complaints.
export const toolComplaints = pgTable(
  "tool_complaints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    // The tool name the complaint is about (tool identifier as the agent
    // sees it in its toolset, e.g. "github_create_issue").
    tool: text("tool").notNull(),
    // Free-text description of the problem.
    issue: text("issue").notNull(),
    severity: text("severity").notNull().default("medium"),
    // Optional heartbeat run id the complaint was filed from.
    runId: uuid("run_id"),
    // Lifecycle status: open -> acknowledged -> resolved.
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("tool_complaints_company_created_idx").on(table.companyId, table.createdAt),
    companyToolIdx: index("tool_complaints_company_tool_idx").on(table.companyId, table.tool),
    companyStatusIdx: index("tool_complaints_company_status_idx").on(table.companyId, table.status),
    agentCreatedIdx: index("tool_complaints_agent_created_idx").on(table.agentId, table.createdAt),
  }),
);
