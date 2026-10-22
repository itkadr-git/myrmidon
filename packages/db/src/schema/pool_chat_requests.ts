import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { poolChatModuleInstances } from "./pool_chat_module_instances.js";

// myrmidon(1.6.6 POOL-CHAT-LEDGER): one durable logical request plus bounded
// attempt/accounting state. Provider credentials and prompts are never stored.
export const poolChatRequests = pgTable(
  "pool_chat_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    moduleId: uuid("module_id").notNull().references(() => poolChatModuleInstances.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    subjectId: text("subject_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    clientMessageId: text("client_message_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull().default("queued"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    usage: jsonb("usage").$type<Record<string, unknown> | null>(),
    charged: boolean("charged"),
    reservationUnits: integer("reservation_units").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityKeyUq: uniqueIndex("pool_chat_requests_identity_key_uq").on(
      table.companyId, table.moduleId, table.channel, table.subjectId, table.idempotencyKey,
    ),
    eventIdentityUq: uniqueIndex("pool_chat_requests_event_identity_uq").on(
      table.companyId, table.moduleId, table.channel, table.subjectId, table.clientMessageId,
    ),
    moduleStatusIdx: index("pool_chat_requests_module_status_idx").on(table.companyId, table.moduleId, table.status),
  }),
);
