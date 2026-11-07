import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * myrmidon(OPE-8836): the installation id of this board, stored once.
 *
 * One row (`singleton_key = 'default'`). The row is created on the first start
 * and never updated: licenses are bound to this value, so it must not follow
 * the machine id, the environment or a re-created container. The licensing
 * screen, the license check and the `instance-id` file read by the closed
 * modules all take the id from here.
 */
export const myrmidonInstallIdentity = pgTable("myrmidon_install_identity", {
  singletonKey: text("singleton_key").primaryKey().default("default"),
  installId: text("install_id").notNull(),
  /** How the id was first determined: `env`, `machine-id` or `generated`. */
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
