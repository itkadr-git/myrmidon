// packages/db/src/schema/myrmidon_owner_activity.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): the owner's last activity per channel.
// The board answers the owner where the owner actually is: the
// portal (a web session request touches `web`) or the Telegram DM bridge (an
// inbound message touches `telegram`). One row per (user, channel); the
// freshest touch younger than the inactivity threshold decides the active
// channel.
//
// Instance-wide, keyed by the board user id, like `announcement_dismissals`
// and `user_sidebar_preferences`: no auth foreign key, because local_trusted
// authenticates the synthetic `local-board` principal rather than an
// `auth_users` row. The table only ever holds a user id, a channel name and a
// timestamp — no message content.

import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const myrmidonOwnerActivity = pgTable(
  "myrmidon_owner_activity",
  {
    /** The board user id (or the synthetic local-board id). */
    userId: text("user_id").notNull(),
    /** `web` (portal session) or `telegram` (inbound DM). */
    channel: text("channel").notNull(),
    /** When the owner was last seen in this channel. */
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userChannelUq: uniqueIndex("myrmidon_owner_activity_user_channel_uq").on(
      table.userId,
      table.channel,
    ),
  }),
);
