// myrmidon(OPE-8985): one-time password-set tokens and the block list of board
// users managed by an instance administrator (users-admin-a).
//
// Only the sha256 of a token is stored; the raw value exists once, inside the
// link handed to the administrator. A token dies on first use, on being
// superseded by a newer one for the same user, or after the server-side TTL.

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const userPasswordSetTokens = pgTable(
  "user_password_set_tokens",
  {
    /** Hex sha256 of the raw token. */
    tokenHash: text("token_hash").primaryKey(),
    /** `user.id` (Better Auth, text). */
    userId: text("user_id").notNull(),
    /** `create` or `reset`. */
    issuedVia: text("issued_via").notNull(),
    issuedByUserId: text("issued_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when the token was used or superseded; live tokens are NULL. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    userIdx: index("user_password_set_tokens_user_idx").on(table.userId, table.revokedAt),
  }),
);

export const userBlocks = pgTable("user_blocks", {
  userId: text("user_id").primaryKey(),
  blockedAt: timestamp("blocked_at", { withTimezone: true }).notNull().defaultNow(),
  blockedByUserId: text("blocked_by_user_id"),
});

export type UserPasswordSetToken = typeof userPasswordSetTokens.$inferSelect;
