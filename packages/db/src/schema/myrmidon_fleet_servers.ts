import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex, jsonb, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * myrmidon(SC1): the fleet-server registry behind the panel's browser console.
 *
 * One row is one node the owner may open an SSH (or VNC) console to from the
 * panel. The row holds the connection target and the name of the panel secret
 * that carries the node password; the password itself is never stored here and
 * never reaches the browser. Table name is namespaced so it cannot collide with
 * a vendor table.
 */
export const myrmidonFleetServers = pgTable(
  "myrmidon_fleet_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    port: integer("port").notNull(),
    protocol: text("protocol").notNull().default("ssh"),
    username: text("username").notNull().default("fleet-console"),
    /** Panel secret key that holds the node password; null means key auth. */
    passwordSecretKey: text("password_secret_key"),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    // myrmidon(SERVER-ONBOARD A): onboarding state, role, host-key pinning and
    // the name of the secret that carries the board's private access key for
    // this node. Values never live here.
    role: text("role").notNull().default("generic"),
    onboardState: text("onboard_state").notNull().default("new"),
    hostKeyFingerprint: text("host_key_fingerprint"),
    accessKeySecretKey: text("access_key_secret_key"),
    bootstrapVersion: text("bootstrap_version"),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_fleet_servers_company_idx").on(table.companyId),
    companySlugUq: uniqueIndex("myrmidon_fleet_servers_company_slug_uq").on(table.companyId, table.slug),
    roleCheck: check("myrmidon_fleet_servers_role_check", sql`${table.role} in ('generic', 'build-runner', 'sandbox', 'bot-host')`),
    onboardStateCheck: check("myrmidon_fleet_servers_onboard_state_check", sql`${table.onboardState} in ('new', 'onboarding', 'ready', 'needs_attention', 'decommissioned')`),
  }),
);

/**
 * myrmidon(SERVER-ONBOARD A): one onboarding/recheck/decommission job on one
 * fleet server. The board creates the job; a separate executor container
 * claims it through the API, pulls one-time secrets, runs the versioned step
 * script over SSH and reports after each step. `step_log` carries step
 * results only — never secret material (masking on both sides).
 */
export const myrmidonFleetOnboardJobs = pgTable(
  "myrmidon_fleet_onboard_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    serverId: uuid("server_id")
      .notNull()
      .references(() => myrmidonFleetServers.id),
    kind: text("kind").notNull().default("onboard"),
    status: text("status").notNull().default("pending"),
    step: text("step"),
    stepLog: jsonb("step_log").notNull().default(sql`'[]'::jsonb`),
    error: text("error"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("myrmidon_fleet_onboard_jobs_company_idx").on(table.companyId),
    serverIdx: index("myrmidon_fleet_onboard_jobs_server_idx").on(table.serverId),
    kindCheck: check("myrmidon_fleet_onboard_jobs_kind_check", sql`${table.kind} in ('onboard', 'recheck', 'decommission')`),
    statusCheck: check("myrmidon_fleet_onboard_jobs_status_check", sql`${table.status} in ('pending', 'claimed', 'running', 'succeeded', 'failed', 'expired')`),
  }),
);