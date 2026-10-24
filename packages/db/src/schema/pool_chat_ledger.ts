import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { poolChatRequests } from "./pool_chat_requests.js";

export const poolChatRequestAttempts = pgTable(
  "pool_chat_request_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull().references(() => poolChatRequests.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    state: text("state").notNull().default("dispatching"),
    provider: text("provider").notNull(),
    accountRef: text("account_ref"),
    reservedUnits: bigint("reserved_units", { mode: "number" }).notNull().default(0),
    settledUnits: bigint("settled_units", { mode: "number" }),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    providerRequestRef: text("provider_request_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestAttemptUq: uniqueIndex("pool_chat_request_attempts_request_no_uq").on(table.requestId, table.attemptNo),
    providerRequestUq: uniqueIndex("pool_chat_request_attempts_provider_ref_uq").on(table.provider, table.providerRequestRef),
    requestIdx: index("pool_chat_request_attempts_request_idx").on(table.companyId, table.requestId),
  }),
);

export const poolChatQuotaReservations = pgTable(
  "pool_chat_quota_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull().references(() => poolChatRequests.id, { onDelete: "cascade" }),
    accountRef: text("account_ref").notNull(),

    units: bigint("units", { mode: "number" }).notNull(),
    state: text("state").notNull().default("reserved"),
    settledUnits: bigint("settled_units", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestUq: uniqueIndex("pool_chat_quota_reservations_request_uq").on(table.requestId),
    companyStateIdx: index("pool_chat_quota_reservations_company_state_idx").on(table.companyId, table.state),
  }),
);
