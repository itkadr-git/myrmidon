// myrmidon(1.7 USERS-ADMIN-UI A): password-set tokens for board users.
//
// A one-time link the admin hands to a user created without a password (or
// after a reset): the token is random 256-bit, stored hashed (sha256), and
// consumed exactly once when the user sets a password through the Better Auth
// reset endpoint (identifier `reset-password:<token>`, the vendor's own
// verification storage). A new token for the same user revokes the older
// outstanding ones; `PASSWORD_SET_MAX_OUTSTANDING` bounds the history.
//
// Additive only: one new table, no vendor table touched, no data rewritten.

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const userPasswordSetTokens = pgTable(
  "user_password_set_tokens",
  {
    /** The user id (`user.id`, text — Better Auth's model). */
    userId: text("user_id").notNull(),
    /** sha256 hex of the raw token; the raw value is returned once. */
    tokenHash: text("token_hash").notNull(),
    /** Which admin path issued it (`create` or `reset`). */
    issuedVia: text("issued_via").notNull(),
    issuedByUserId: text("issued_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the token was used or superseded; a live token is NULL. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    // The lookup every password-set consumes: one live token by hash.
    tokenHashIdx: index("user_password_set_tokens_hash_idx").on(table.tokenHash),
    // Revoking the previous tokens of one user.
    userIdx: index("user_password_set_tokens_user_idx").on(table.userId, table.revokedAt),
  }),
);

export type UserPasswordSetToken = typeof userPasswordSetTokens.$inferSelect;
export type NewUserPasswordSetToken = typeof userPasswordSetTokens.$inferInsert;
