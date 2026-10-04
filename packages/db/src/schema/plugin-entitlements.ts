import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { plugins } from './plugins';
import { sql } from 'drizzle-orm';

export const pluginEntitlements = pgTable('plugin_entitlements', {
  id: text('id').primaryKey().default(sql`(gen_random_uuid())`),
  pluginId: text('plugin_id')
    .notNull()
    .references(() => plugins.id, { onDelete: 'cascade' }),
  entitlementKey: text('entitlement_key').notNull(), // Hashed storage of the entitlement key
  publicKey: text('public_key').notNull(), // Public key for signature verification
  instanceId: text('instance_id').notNull(), // Instance this entitlement is valid for
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// Indexes will be created via raw SQL in the migration since Drizzle doesn't support all index types