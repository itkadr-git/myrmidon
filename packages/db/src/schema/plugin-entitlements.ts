import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";

export const pluginEntitlements = pgTable(
  "plugin_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    entitlementKey: text("entitlement_key").notNull(),
    publicKey: text("public_key").notNull(),
    instanceId: text("instance_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: index("idx_plugin_entitlements_plugin_id").on(table.pluginId),
    instanceIdx: index("idx_plugin_entitlements_instance_id").on(table.instanceId),
    expiresIdx: index("idx_plugin_entitlements_expires_at").on(table.expiresAt),
  }),
);
