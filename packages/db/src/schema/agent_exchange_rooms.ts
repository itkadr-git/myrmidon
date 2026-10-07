// packages/db/src/schema/agent_exchange_rooms.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): the discussion-room tables.
//
// Why tables and not JSON on the issue: a room is a *conversation grid* —
// rounds × participants — and the room's own rules ("a participant of round 1
// must not see the other first answers", "the stop valve ends the room
// without new model calls") are enforced by reads over that grid. Flattening
// it into the issue payload would make every read a parse and every stop a
// rewrite of the whole blob.
//
// Two tables, additive only; no vendor table is touched:
//
// - `agent_exchange_rooms` — one row per room: who opened it, who may stop it
//   (the stop valve), the participant roster and finisher model as JSON (the
//   roster is written once at open and never edited), the round and token
//   ceilings resolved at open (the room keeps its own copy so a later
//   settings change does not retroactively shrink a live room), the running
//   totals the summary reports, and the summary document key.
// - `agent_exchange_messages` — one row per participant answer (one cell of
//   the round grid). `status` is `pending` between the dispatch and the
//   landing, so a crash mid-round leaves a resumable room, not a silent gap.
//
// Cost accounting lives on the row: each message carries the token usage the
// provider answered with and the price the model catalog knew at call time;
// the room carries the running sums. The summary document is written from
// those sums, so the number on the issue and the number on the room cannot
// disagree.

import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const agentExchangeRooms = pgTable(
  "agent_exchange_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The task card the room discusses. */
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** `open` | `stopped` | `completed`. */
    status: text("status").notNull().default("open"),
    /** Who opened the room (`user` | `agent` + the id). */
    openerType: text("opener_type").notNull(),
    openerId: text("opener_id").notNull(),
    /** The stop valve: who may stop the room (same pair). */
    stopperType: text("stopper_type").notNull(),
    stopperId: text("stopper_id").notNull(),
    /** The roster and the finisher, frozen at open. */
    participants: jsonb("participants").notNull(),
    finisher: jsonb("finisher"),
    /** The ceilings resolved at open (settings of that moment). */
    maxRounds: integer("max_rounds").notNull(),
    tokenBudget: integer("token_budget").notNull(),
    /** Running totals; the summary reports exactly these. */
    tokensUsed: integer("tokens_used").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    currentRound: integer("current_round").notNull().default(0),
    /** `owner_stop` when the stop valve ended the room. */
    stopReason: text("stop_reason"),
    /** The issue-document key (`exchange:<roomId>`) once the summary is written. */
    summaryDocumentKey: text("summary_document_key"),
    /** Seam for DEBATE-ASYM: the judge verdict; null while that part is unmerged. */
    judge: jsonb("judge"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIssueIdx: index("agent_exchange_rooms_company_issue_idx").on(table.companyId, table.issueId),
    companyStatusIdx: index("agent_exchange_rooms_company_status_idx").on(table.companyId, table.status),
  }),
);

export const agentExchangeMessages = pgTable(
  "agent_exchange_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => agentExchangeRooms.id, { onDelete: "cascade" }),
    /** `round >= 1`; the finisher is not a round and has no message. */
    round: integer("round").notNull(),
    /** Index into the room's frozen roster. */
    participantIndex: integer("participant_index").notNull(),
    /** `pending` | `done` | `error`. */
    status: text("status").notNull().default("pending"),
    /** The answer; null until the call lands. */
    content: text("content"),
    /** `participant_error:<code>` on a failed call. */
    error: text("error"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    /** Hundredths of a cent (the shared `agentExchangeCallCostCents` returns them). */
    costCents: integer("cost_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    roomRoundIdx: index("agent_exchange_messages_room_round_idx").on(table.roomId, table.round),
    /** One cell of the grid exists once: the redispatch of a pending cell reuses its row. */
    cellUq: uniqueIndex("agent_exchange_messages_cell_uq").on(
      table.roomId,
      table.round,
      table.participantIndex,
    ),
  }),
);

export type AgentExchangeRoomRow = typeof agentExchangeRooms.$inferSelect;
export type NewAgentExchangeRoomRow = typeof agentExchangeRooms.$inferInsert;
export type AgentExchangeMessageRow = typeof agentExchangeMessages.$inferSelect;
export type NewAgentExchangeMessageRow = typeof agentExchangeMessages.$inferInsert;
