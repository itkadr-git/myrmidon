// packages/db/src/schema/myrmidon_channel_allowed_users.ts
//
// myrmidon(CA-A): the channel allowlist — who may write to the company's
// bots, independent of company membership. The owner's rule (OPE-4949):
// a person is admitted by their channel identity (a Telegram id, a
// @username), NOT by a board account; the board link is an optional
// convenience when the person has one. The mechanism lives in the general
// channel layer: `provider` is any chat provider, Telegram is the first
// consumer (the vendor's own "identity link vs membership" split, #13638,
// is the shape this table follows).
//
// One row per person per admission scope:
//   - scope `company`, endpoint_id = null — the person may write to every
//     bot of the company;
//   - scope `endpoint`, endpoint_id = the bot endpoint — the person may
//     write to that bot only.
// A row is keyed by the provider's external id (numeric Telegram id — the
// stable identifier the chat layer already uses for principals); the
// @username handle is stored for the human-facing card and for matching
// when the provider event carries no numeric id.
//
// `board_user_id` is the optional board-account link (owner clarification
// 06.10: not required). Rights on the writer arrive in Part B.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { chatEndpoints } from "./chat_channels.js";
import type { ChatProvider } from "@paperclipai/shared";

export const myrmidonChannelAllowedUsers = pgTable(
  "myrmidon_channel_allowed_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ChatProvider>().notNull(),
    /** The provider's stable user id (Telegram numeric id, Slack user id, …). */
    externalId: text("external_id").notNull(),
    /** The human-facing handle as shown on the access card (`@name`). */
    handle: text("handle"),
    displayName: text("display_name"),
    /** `company` (every bot of the company) or `endpoint` (one bot). */
    scope: text("scope").notNull().default("company"),
    /** scope `endpoint`: the bot endpoint this admission covers. */
    endpointId: uuid("endpoint_id"),
    /** Optional board-account link — never required for admission. */
    boardUserId: text("board_user_id"),
    /** `active` admits, `revoked` keeps the row for audit and never admits. */
    status: text("status").notNull().default("active"),
    /** Who added the row (board user id or "system"), for the audit trail. */
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "myrmidon_channel_allowed_users_scope_check",
      sql`${table.scope} in ('company', 'endpoint')`,
    ),
    check(
      "myrmidon_channel_allowed_users_status_check",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    check(
      "myrmidon_channel_allowed_users_endpoint_scope_check",
      sql`(${table.scope} = 'company' and ${table.endpointId} is null) or (${table.scope} = 'endpoint' and ${table.endpointId} is not null)`,
    ),
    index("myrmidon_channel_allowed_users_company_idx").on(table.companyId),
    index("myrmidon_channel_allowed_users_company_provider_idx").on(
      table.companyId,
      table.provider,
      table.status,
    ),
    uniqueIndex("myrmidon_channel_allowed_users_admission_uq").on(
      table.companyId,
      table.provider,
      table.externalId,
      table.scope,
      table.endpointId,
    ),
    foreignKey({
      columns: [table.companyId, table.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
      name: "myrmidon_channel_allowed_users_company_endpoint_fk",
    }).onDelete("cascade"),
  ],
);
