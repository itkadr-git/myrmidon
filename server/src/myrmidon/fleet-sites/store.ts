import { and, asc, eq } from "drizzle-orm";
import { myrmidonFleetSites, type Db } from "@paperclipai/db";
import type { FleetSiteInput, FleetSiteStatus, FleetSiteView } from "./domain.js";

export interface FleetSiteStore {
  list(companyId: string): Promise<FleetSiteView[]>;
  create(input: FleetSiteInput): Promise<FleetSiteView>;
  patch(companyId: string, slug: string, status: FleetSiteStatus): Promise<FleetSiteView | null>;
}

type Row = typeof myrmidonFleetSites.$inferSelect;
function toView(row: Row): FleetSiteView {
  return {
    id: row.id, slug: row.slug, fleetdUrl: row.fleetdUrl, label: row.label,
    siteCaFingerprint: row.siteCaFingerprint, region: row.region,
    capacityCpu: row.capacityCpu, capacityRamGb: row.capacityRamGb,
    maxBots: row.maxBots, maxRunTokensMin: row.maxRunTokensMin,
    status: row.status as FleetSiteStatus,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export function fleetSiteStore(db: Db): FleetSiteStore {
  return {
    async list(companyId) {
      const rows = await db.select().from(myrmidonFleetSites)
        .where(eq(myrmidonFleetSites.companyId, companyId)).orderBy(asc(myrmidonFleetSites.slug));
      return rows.map(toView);
    },
    async create(input) {
      const [row] = await db.insert(myrmidonFleetSites).values({
        companyId: input.companyId, slug: input.slug, fleetdUrl: input.fleetdUrl,
        label: input.label, siteCaFingerprint: input.siteCaFingerprint ?? null,
        region: input.region ?? null, capacityCpu: input.capacityCpu,
        capacityRamGb: input.capacityRamGb, maxBots: input.maxBots ?? null,
        maxRunTokensMin: input.maxRunTokensMin ?? null, status: input.status ?? "enabled",
      }).returning();
      return toView(row!);
    },
    async patch(companyId, slug, status) {
      const [row] = await db.update(myrmidonFleetSites).set({ status, updatedAt: new Date() })
        .where(and(eq(myrmidonFleetSites.companyId, companyId), eq(myrmidonFleetSites.slug, slug))).returning();
      return row ? toView(row) : null;
    },
  };
}
