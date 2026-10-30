// server/src/myrmidon/bot-containers/site-health-routes.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): read-only view of the remote sites for the badges.
//
//   GET /myrmidon/fleet/sites?companyId=…  — each site's registry status and monitor state
//
// The monitor writes the state; this only reads it. Managing sites (add, drain, resume) is the
// fleet screen's API (T8), not this one.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { myrmidonFleetSites, type Db } from "@myrmidon/db";
import { badRequest } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";

export type SiteBadgeState = "unknown" | "healthy" | "degraded" | "unreachable" | "draining" | "quarantined";

export interface FleetSiteBadge {
  name: string;
  /** What the badge shows: the registry status wins over the probe state (draining, quarantined). */
  state: SiteBadgeState;
  /** The registry status as stored. */
  status: string;
  /** True when the monitor drained the site itself (an operator's drain is false). */
  autoDrained: boolean;
  lastSeenAt: string | null;
}

const PROBE_STATES: readonly SiteBadgeState[] = ["unknown", "healthy", "degraded", "unreachable", "draining", "quarantined"];

/** Pure: the badge of one registry row. */
export function siteBadge(row: {
  name: string;
  status: string;
  lastSeenAt: Date | null;
  health: { state?: string; autoDrained?: boolean } | null;
}): FleetSiteBadge {
  const probed = (PROBE_STATES as readonly string[]).includes(row.health?.state ?? "")
    ? (row.health!.state as SiteBadgeState)
    : "unknown";
  let state: SiteBadgeState = probed;
  if (row.status === "quarantined") state = "quarantined";
  else if (row.status === "draining") state = probed === "unreachable" ? "unreachable" : "draining";
  else if (row.status === "disabled") state = "unknown";
  return {
    name: row.name,
    state,
    status: row.status,
    autoDrained: row.health?.autoDrained === true,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
  };
}

export function siteHealthRoutes(db: Db): Router {
  const router = Router();

  router.get("/myrmidon/fleet/sites", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    const rows = await db.select().from(myrmidonFleetSites).where(eq(myrmidonFleetSites.companyId, companyId));
    res.json({ sites: rows.map((row) => siteBadge(row)).sort((a, b) => a.name.localeCompare(b.name)) });
  });

  return router;
}
