// server/src/myrmidon/bot-containers/fleet-site-manage-routes.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T8): the API behind the fleet screen (design §2.3). The site is
// enrolled by fleet-site-routes.ts, the bot move is fleet-move-routes.ts, the plain badge feed
// is site-health-routes.ts; this file is the rest of what the screen does:
//
//   GET   /myrmidon/fleet/sites/overview?companyId=     sites: status, lastSeen, capacity used/total, bots, drift, key TTL
//   GET   /myrmidon/fleet/sites/:name/bots?companyId=   the site's bots: state, image, drift, gateway address
//   PATCH /myrmidon/fleet/sites/:name?companyId=        labels, capacity, address (admin)
//   POST  /myrmidon/fleet/sites/:name/drain?companyId=  operator drain: no new placements (admin)
//   POST  /myrmidon/fleet/sites/:name/resume?companyId= lifts a drain (admin)
//   POST  /myrmidon/fleet/bots/:key/restart             restart the bot's container on its site (admin)
//   POST  /myrmidon/fleet/bots/:key/stop                stop it (admin)
//   GET   /myrmidon/fleet/bots/:key/logs?tail=          the tail of the container log through the site-agent
//
// Every call that reaches a site (restart, stop, logs, resume) is refused while the board's
// client certificate for that site has expired, and the refusal is logged as an alert: an
// expired key is never retried against the site. Secrets never appear in an answer.

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { HttpError, badRequest, conflict, notFound } from "../../errors.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdmin } from "../../routes/authz.js";
import { normalizeFleetdUrl } from "./fleet-site-routes.js";
import { siteBadge, type FleetSiteBadge } from "./site-health-routes.js";
import type { FleetSite, FleetSiteUpdate } from "./site-registry.js";

const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const DEFAULT_TAIL = 100;
const MAX_TAIL = 500;

const patchBodySchema = z
  .object({
    url: z.string().trim().min(1).optional(),
    labels: z.record(z.string().regex(LABEL_KEY), z.string().max(200)).optional(),
    capacity: z
      .object({
        maxCpus: z.number().positive(),
        maxMemoryMb: z.number().int().positive(),
        maxPids: z.number().int().positive().optional(),
        maxBots: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** What the board knows about the load on one site; a field is null when it could not be read. */
export interface SiteLoad {
  bots: number;
  /** Sum of the cards' cpu / memory limits of the bots placed on the site. */
  cpus: number;
  memoryMb: number;
  /** Bots whose live container no longer matches the card; null when the site did not answer. */
  driftCount: number | null;
}

export interface SiteBotView {
  botKey: string;
  agentName: string;
  /** Container state as the site reports it; "unknown" when the site did not answer. */
  state: string;
  image: string | null;
  drift: boolean;
  driftFields: string[];
  apiBaseUrl: string | null;
  gatewayPort: number | null;
  pinned: boolean;
}

export interface BotCardView {
  companyId: string;
  /** container.host of the card; null for a bot that runs on the board host. */
  host: string | null;
}

export type SiteBotAction = "restart" | "stop";

export interface FleetSiteManageDeps {
  listSites(companyId: string): Promise<FleetSite[]>;
  getSite(companyId: string, name: string): Promise<FleetSite | null>;
  updateSite(companyId: string, name: string, patch: FleetSiteUpdate): Promise<FleetSite | null>;
  /** Compare-and-swap on the status; false when another writer changed it first. */
  setStatus(siteId: string, from: readonly string[], to: "active" | "draining"): Promise<boolean>;
  /** Marks the current drain (or its absence) as the operator's: the monitor then never lifts it. */
  markOperatorState(siteId: string): Promise<void>;
  siteLoad(companyId: string, siteName: string): Promise<SiteLoad>;
  listSiteBots(companyId: string, siteName: string): Promise<SiteBotView[]>;
  botCard(botKey: string): Promise<BotCardView | null>;
  actOnBot(botKey: string, action: SiteBotAction): Promise<void>;
  botLogs(companyId: string, siteName: string, botKey: string): Promise<string>;
  now?: () => number;
  log?: { warn?(fields: Record<string, unknown>, message: string): void };
}

export interface SiteOverviewRow extends FleetSiteBadge {
  url: string;
  labels: Record<string, string>;
  /** End of the board's client certificate for the site: the key's TTL. Null when it was not readable at enroll. */
  clientCertNotAfter: string | null;
  certExpired: boolean;
  capacity: {
    cpus: { used: number; total: number };
    memoryMb: { used: number; total: number };
    bots: { used: number; total: number | null };
  };
  botCount: number;
  driftCount: number | null;
  enrolledAt: string;
}

function certExpired(site: Pick<FleetSite, "clientCertNotAfter">, nowMs: number): boolean {
  if (!site.clientCertNotAfter) return false;
  const end = new Date(site.clientCertNotAfter).getTime();
  return Number.isFinite(end) && end <= nowMs;
}

export function fleetSiteManageRoutes(deps: FleetSiteManageDeps): Router {
  const router = Router();
  const nowMs = () => (deps.now ?? Date.now)();

  function companyFromQuery(req: Request, admin: boolean): string {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
    if (!companyId) throw badRequest("companyId is required");
    if (admin) assertCompanyAdmin(req, companyId);
    else assertCompanyAccess(req, companyId);
    return companyId;
  }

  function siteName(req: Request): string {
    const name = typeof req.params.name === "string" ? req.params.name : "";
    if (!name) throw badRequest("name required");
    return name;
  }

  async function requireSite(companyId: string, name: string): Promise<FleetSite> {
    const site = await deps.getSite(companyId, name);
    if (!site) throw notFound(`Site "${name}" not found`);
    return site;
  }

  /** The refusal for a site whose client certificate has expired: logged as an alert, answered 409. */
  function refuseExpired(site: FleetSite, what: string): never {
    deps.log?.warn?.(
      { site: site.name, clientCertNotAfter: site.clientCertNotAfter ? new Date(site.clientCertNotAfter).toISOString() : null, what },
      "remote site client certificate expired: the call is refused",
    );
    throw conflict(`Site "${site.name}": the board's client certificate expired; rotate it before ${what}`);
  }

  async function handleOverview(req: Request, res: Response): Promise<void> {
    const companyId = companyFromQuery(req, false);
    const sites = await deps.listSites(companyId);
    const rows: SiteOverviewRow[] = await Promise.all(
      sites.map(async (site) => {
        const load = await deps.siteLoad(companyId, site.name).catch(() => ({ bots: 0, cpus: 0, memoryMb: 0, driftCount: null }) as SiteLoad);
        const badge = siteBadge({
          name: site.name,
          status: site.status,
          lastSeenAt: site.lastSeenAt ? new Date(site.lastSeenAt) : null,
          health: site.health ?? null,
        });
        const expired = certExpired(site, nowMs());
        if (expired) {
          deps.log?.warn?.({ site: site.name }, "remote site client certificate expired");
        }
        return {
          ...badge,
          url: site.url,
          labels: site.labels ?? {},
          clientCertNotAfter: site.clientCertNotAfter ? new Date(site.clientCertNotAfter).toISOString() : null,
          certExpired: expired,
          capacity: {
            cpus: { used: load.cpus, total: site.capacity.maxCpus },
            memoryMb: { used: load.memoryMb, total: site.capacity.maxMemoryMb },
            bots: { used: load.bots, total: site.capacity.maxBots ?? null },
          },
          botCount: load.bots,
          driftCount: load.driftCount,
          enrolledAt: new Date(site.enrolledAt).toISOString(),
        };
      }),
    );
    rows.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ sites: rows });
  }

  async function handleBots(req: Request, res: Response): Promise<void> {
    const companyId = companyFromQuery(req, false);
    const site = await requireSite(companyId, siteName(req));
    res.json({ site: site.name, bots: await deps.listSiteBots(companyId, site.name) });
  }

  async function handlePatch(req: Request, res: Response): Promise<void> {
    const companyId = companyFromQuery(req, true);
    const site = await requireSite(companyId, siteName(req));
    const parsed = patchBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(`Invalid site update: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;
    if (Object.keys(body).length === 0) throw badRequest("Nothing to update: url, labels or capacity expected");
    const patch: FleetSiteUpdate = {};
    if (body.url !== undefined) {
      try {
        patch.url = normalizeFleetdUrl(body.url);
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : "invalid url");
      }
    }
    if (body.labels !== undefined) patch.labels = body.labels;
    if (body.capacity !== undefined) {
      const start = site.profile.gatewayPortStart;
      const end = site.profile.gatewayPortEnd;
      if (body.capacity.maxBots !== undefined && start !== undefined && end !== undefined && body.capacity.maxBots > end - start + 1) {
        throw badRequest(`capacity.maxBots (${body.capacity.maxBots}) exceeds the gateway port range (${end - start + 1} ports)`);
      }
      patch.capacity = body.capacity;
    }
    const updated = await deps.updateSite(companyId, site.name, patch);
    if (!updated) throw notFound(`Site "${site.name}" not found`);
    res.json({ ok: true, site: updated.name });
  }

  async function handleDrain(req: Request, res: Response): Promise<void> {
    const companyId = companyFromQuery(req, true);
    const site = await requireSite(companyId, siteName(req));
    if (site.status === "draining") {
      // Already out of placement. An operator's press makes the drain theirs: the monitor must not lift it.
      await deps.markOperatorState(site.id);
      res.json({ ok: true, site: site.name, status: "draining", changed: false });
      return;
    }
    if (site.status !== "active") throw conflict(`Site "${site.name}" is ${site.status}: only an active site can be drained`);
    if (!(await deps.setStatus(site.id, ["active"], "draining"))) {
      throw conflict(`Site "${site.name}" changed status meanwhile; reload and retry`);
    }
    await deps.markOperatorState(site.id);
    res.json({ ok: true, site: site.name, status: "draining", changed: true });
  }

  async function handleResume(req: Request, res: Response): Promise<void> {
    const companyId = companyFromQuery(req, true);
    const site = await requireSite(companyId, siteName(req));
    if (site.status === "active") {
      res.json({ ok: true, site: site.name, status: "active", changed: false });
      return;
    }
    if (site.status !== "draining") {
      throw conflict(`Site "${site.name}" is ${site.status}: only a draining site can be resumed`);
    }
    if (certExpired(site, nowMs())) refuseExpired(site, "resuming it");
    if (!(await deps.setStatus(site.id, ["draining"], "active"))) {
      throw conflict(`Site "${site.name}" changed status meanwhile; reload and retry`);
    }
    await deps.markOperatorState(site.id);
    res.json({ ok: true, site: site.name, status: "active", changed: true });
  }

  /** The bot's card, its company's access check, and its site (a bot on the board host has none). */
  async function botContext(req: Request, admin: boolean): Promise<{ botKey: string; companyId: string; site: FleetSite }> {
    assertBoard(req);
    const botKey = typeof req.params.key === "string" ? req.params.key : "";
    if (!botKey) throw badRequest("botKey required");
    const card = await deps.botCard(botKey);
    if (!card) throw notFound(`Bot "${botKey}" not found`);
    if (admin) assertCompanyAdmin(req, card.companyId);
    else assertCompanyAccess(req, card.companyId);
    if (!card.host) throw conflict(`Bot "${botKey}" runs on the board host, not on a remote site`);
    const site = await deps.getSite(card.companyId, card.host);
    if (!site) throw notFound(`Site "${card.host}" of bot "${botKey}" is not in the registry`);
    return { botKey, companyId: card.companyId, site };
  }

  function botAction(action: SiteBotAction) {
    return async (req: Request, res: Response): Promise<void> => {
      const { botKey, site } = await botContext(req, true);
      if (site.status === "disabled" || site.status === "quarantined") {
        throw conflict(`Site "${site.name}" is ${site.status}: bots on it cannot be ${action === "restart" ? "restarted" : "stopped"} from the board`);
      }
      if (certExpired(site, nowMs())) refuseExpired(site, `${action === "restart" ? "restarting" : "stopping"} its bots`);
      try {
        await deps.actOnBot(botKey, action);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `Site "${site.name}" could not ${action} bot "${botKey}": ${err instanceof Error ? err.message : String(err)}`);
      }
      res.json({ ok: true, botKey, site: site.name, action });
    };
  }

  async function handleLogs(req: Request, res: Response): Promise<void> {
    const { botKey, companyId, site } = await botContext(req, false);
    const rawTail = typeof req.query.tail === "string" ? req.query.tail.trim() : "";
    let tail = DEFAULT_TAIL;
    if (rawTail) {
      tail = Number(rawTail);
      if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) throw badRequest(`tail: an integer from 1 to ${MAX_TAIL}`);
    }
    if (certExpired(site, nowMs())) refuseExpired(site, "reading its logs");
    let text: string;
    try {
      text = await deps.botLogs(companyId, site.name, botKey);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Site "${site.name}" could not give the log of bot "${botKey}": ${err instanceof Error ? err.message : String(err)}`);
    }
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    res.json({ botKey, site: site.name, tail, logs: lines.slice(-tail).join("\n") });
  }

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

  router.get("/myrmidon/fleet/sites/overview", wrap(handleOverview));
  router.get("/myrmidon/fleet/sites/:name/bots", wrap(handleBots));
  router.patch("/myrmidon/fleet/sites/:name", wrap(handlePatch));
  router.post("/myrmidon/fleet/sites/:name/drain", wrap(handleDrain));
  router.post("/myrmidon/fleet/sites/:name/resume", wrap(handleResume));
  router.post("/myrmidon/fleet/bots/:key/restart", wrap(botAction("restart")));
  router.post("/myrmidon/fleet/bots/:key/stop", wrap(botAction("stop")));
  router.get("/myrmidon/fleet/bots/:key/logs", wrap(handleLogs));

  return router;
}
