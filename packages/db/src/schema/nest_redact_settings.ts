import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";

export const nestRedactSettings = pgTable("nest_redact_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  nestId: uuid("nest_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ nestIdx: uniqueIndex("nest_redact_settings_nest_idx").on(table.nestId) }));
