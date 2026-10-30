import { pgTable, uuid, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export interface FleetSiteCapacity {
  maxCpus: number;
  maxMemoryMb: number;
  maxPids?: number;
  maxBots?: number;
}

/** myrmidon(1.6.6 REMOTE-SITES-T4): the health monitor's persisted state of one site. */
export interface FleetSiteHealth {
  /** The reducer snapshot (packages/shared remote-sites health-reducer); timestamps are epoch ms. */
  snapshot: Record<string, unknown>;
  /** True while the draining status was set by the monitor itself (not by an operator). */
  autoDrained: boolean;
  /** The last reducer state, for the badge. */
  state: string;
  /** Consecutive successful probes since the last miss (the return-reconcile pass waits for three). */
  recoveryPasses: number;
  /** True once the return reconcile (stop foreign containers) has run for the current return. */
  reconciled: boolean;
  updatedAt: string;
}

export interface FleetSiteProfile {
  hindsightUrl?: string;
  llmBaseUrl?: string;
  boardExtraHost?: string;
  volumeRoot?: string;
  network?: string;
  imageAllowlist?: string[] | readonly string[];
  /** myrmidon(OPE-8999): the host-port range the site's fleetd hands out for bot gateways (informational; fleetd.json is authoritative). */
  gatewayPortStart?: number;
  gatewayPortEnd?: number;
  egressProfile?: string;
}

/**
 * myrmidon(1.6.6 REMOTE-SITES-T1): execution site registry.
 *
 * Each row represents one remote execution site (e.g. myr-vm1).
 * The site runs fleetd (site-agent) which executes container lifecycle methods
 * under mTLS client auth.
 */
export const myrmidonFleetSites = pgTable(
  "myrmidon_fleet_sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    tokenSecret: text("token_secret"),
    caCert: text("ca_cert"),
    caCertFingerprint: text("ca_cert_fingerprint"),
    clientCert: text("client_cert"),
    clientCertSecretKey: text("client_cert_secret_key"),
    clientCertNotAfter: timestamp("client_cert_not_after", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    capacity: jsonb("capacity").$type<FleetSiteCapacity>().notNull().default({ maxCpus: 8, maxMemoryMb: 32768 }),
    profile: jsonb("profile").$type<FleetSiteProfile>().notNull().default({}),
    labels: jsonb("labels").$type<Record<string, string>>().default({}),
    // myrmidon(1.6.6 REMOTE-SITES-T4): written by the site health monitor only.
    health: jsonb("health").$type<FleetSiteHealth>(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    certRotatedAt: timestamp("cert_rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_fleet_sites_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("myrmidon_fleet_sites_company_name_uq").on(table.companyId, table.name),
  }),
);

export const fleetSites = myrmidonFleetSites;
