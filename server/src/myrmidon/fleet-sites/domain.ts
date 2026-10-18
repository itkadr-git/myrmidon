import { z } from "zod";

export const FLEET_SITE_STATUSES = ["enabled", "draining", "disabled", "unreachable"] as const;
export type FleetSiteStatus = (typeof FLEET_SITE_STATUSES)[number];
export const FLEET_SITE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const fleetSiteSchema = z.object({
  companyId: z.string().uuid(),
  slug: z.string().trim().regex(FLEET_SITE_SLUG_PATTERN),
  fleetdUrl: z.string().url().refine((value) => new URL(value).protocol === "https:", "fleetdUrl must use https"),
  label: z.string().trim().min(1).max(120),
  siteCaFingerprint: z.string().trim().max(255).nullable().optional(),
  region: z.string().trim().max(120).nullable().optional(),
  capacityCpu: z.number().positive(),
  capacityRamGb: z.number().positive(),
  maxBots: z.number().int().positive().nullable().optional(),
  maxRunTokensMin: z.number().int().positive().nullable().optional(),
  status: z.enum(FLEET_SITE_STATUSES).optional(),
}).strict();

export const fleetSitePatchSchema = z.object({
  companyId: z.string().uuid(),
  status: z.enum(FLEET_SITE_STATUSES),
}).strict();

export type FleetSiteInput = z.infer<typeof fleetSiteSchema>;
export type FleetSiteView = Omit<FleetSiteInput, "companyId"> & { id: string; createdAt: string; updatedAt: string };

export function parseFleetSite(value: unknown): FleetSiteInput {
  return fleetSiteSchema.parse(value);
}
