// server/src/myrmidon/bot-containers/fleet-audit.ts
//
// myrmidon(fleet-site audit): the activity log of the fleet's control calls.
//
// What an operator does to a remote site or to a bot on it — enroll or delete the site, change its
// settings, drain or resume it, restart or stop a bot, move a bot to another site, read a bot's
// container log — leaves one row in the company's activity log (`logActivity`, the same table and
// the same row shape as the other myrmidon modules write: bot-disk-quota-routes.ts and others):
// who (actor), what (action), on what (site name or bot id), the outcome and a few non-secret facts.
//
// It sits in front of the fleet routers (withFleetAudit, bound in the wiring files) and records
// the call when its response is sent, so the row carries what the call really came to: ok, denied,
// refused by a rule, or failed on the site. The routers themselves are not touched.
//
// Rules:
//   - A call is recorded only for an actor who belongs to the company of the call. A denied call of
//     an outsider is not written into somebody else's trail.
//   - Request values are never copied whole. A patch is recorded by the names of its fields (and the
//     two network flags and the address, which are the facts an audit of plain http needs), an
//     enroll by site name, address and flags. Tokens, secret names and certificates are not recorded.
//   - Reading the log of a bot is recorded at most once a minute per actor and bot, so a screen that
//     refreshes the log does not fill the trail.
//   - A failed write is logged as a warning and never changes the answer of the call.

import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import type { LogActivityInput } from "../../services/activity-log.js";
import { getActorInfo } from "../../routes/authz.js";

export interface FleetAuditDeps {
  logActivity(input: LogActivityInput): Promise<unknown>;
  /** The company that owns the bot (its card), or null: for the calls that name only the bot. */
  botCompanyId(botKey: string): Promise<string | null>;
  now?: () => number;
  log?: { warn(fields: object, message: string): void };
}

/** Same bot, same actor, same action: one row a minute for the calls that only read. */
export const FLEET_AUDIT_READ_WINDOW_MS = 60_000;

export type FleetAuditOutcome = "ok" | "denied" | "rejected" | "failed";

export interface AuditedCall {
  action: string;
  entityType: "fleet_site" | "agent";
  /** Site name or bot id; null when the request does not carry it (an enroll names the site in its body). */
  entityId: string | null;
  /** Where the company comes from: the path, the query string, or the card of the bot. */
  company: { from: "path"; id: string } | { from: "query" } | { from: "bot"; botKey: string };
  /** A read: recorded at most once per FLEET_AUDIT_READ_WINDOW_MS per actor and entity. */
  read: boolean;
}

const API = "(?:/api)*";
const FLEET = `${API}(?:/myrmidon)?/fleet`;
const SEGMENT = "([^/]+)";

const SITE_COLLECTION = new RegExp(`^${API}/companies/${SEGMENT}/fleet/sites/?$`);
const SITE_ITEM = new RegExp(`^${API}/companies/${SEGMENT}/fleet/sites/${SEGMENT}/?$`);
const SITE_MANAGE = new RegExp(`^${FLEET}/sites/${SEGMENT}/?$`);
const SITE_ACTION = new RegExp(`^${FLEET}/sites/${SEGMENT}/(drain|resume)/?$`);
const BOT_ACTION = new RegExp(`^${FLEET}/bots/${SEGMENT}/(restart|stop|move|logs)/?$`);

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Which audited call a request is, or null for every other request. */
export function classifyFleetCall(method: string, pathname: string): AuditedCall | null {
  let match: RegExpExecArray | null;
  if (method === "POST" && (match = SITE_COLLECTION.exec(pathname))) {
    const companyId = decoded(match[1]);
    return companyId === null ? null : { action: "fleet.site.enroll", entityType: "fleet_site", entityId: null, company: { from: "path", id: companyId }, read: false };
  }
  if (method === "DELETE" && (match = SITE_ITEM.exec(pathname))) {
    const companyId = decoded(match[1]);
    const name = decoded(match[2]);
    return companyId === null || name === null
      ? null
      : { action: "fleet.site.delete", entityType: "fleet_site", entityId: name, company: { from: "path", id: companyId }, read: false };
  }
  if (method === "POST" && (match = SITE_ACTION.exec(pathname))) {
    const name = decoded(match[1]);
    return name === null ? null : { action: `fleet.site.${match[2]}`, entityType: "fleet_site", entityId: name, company: { from: "query" }, read: false };
  }
  if (method === "PATCH" && (match = SITE_MANAGE.exec(pathname))) {
    const name = decoded(match[1]);
    return name === null ? null : { action: "fleet.site.patch", entityType: "fleet_site", entityId: name, company: { from: "query" }, read: false };
  }
  if ((match = BOT_ACTION.exec(pathname))) {
    const botKey = decoded(match[1]);
    const verb = match[2];
    if (botKey === null) return null;
    const wanted = verb === "logs" ? "GET" : "POST";
    if (method !== wanted) return null;
    return { action: `fleet.bot.${verb}`, entityType: "agent", entityId: botKey, company: { from: "bot", botKey }, read: verb === "logs" };
  }
  return null;
}

export function outcomeOf(status: number): FleetAuditOutcome {
  if (status >= 500) return "failed";
  if (status === 401 || status === 403) return "denied";
  if (status >= 400) return "rejected";
  return "ok";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/** `https://host:port` of a URL, without credentials, path or query; undefined when it is not a URL. */
function originOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/** The facts of the call that are safe to keep. Values of a patch are not copied, except the ones named here. */
function detailsOf(call: AuditedCall, req: Request): Record<string, unknown> {
  const body = isRecord(req.body) ? req.body : {};
  const query = req.query as Record<string, unknown>;
  switch (call.action) {
    case "fleet.site.enroll":
      return {
        site: text(body.name),
        url: originOf(body.url),
        privateNetwork: typeof body.privateNetwork === "boolean" ? body.privateNetwork : undefined,
        tunnel: typeof body.tunnel === "boolean" ? body.tunnel : undefined,
      };
    case "fleet.site.patch":
      return {
        fields: Object.keys(body).sort(),
        url: originOf(body.url),
        privateNetwork: typeof body.privateNetwork === "boolean" ? body.privateNetwork : undefined,
        tunnel: typeof body.tunnel === "boolean" ? body.tunnel : undefined,
        gatewayPortStart: typeof body.gatewayPortStart === "number" ? body.gatewayPortStart : undefined,
        gatewayPortEnd: typeof body.gatewayPortEnd === "number" ? body.gatewayPortEnd : undefined,
      };
    case "fleet.bot.move":
      return { toSite: text(body.to) ?? text(body.toSite) };
    case "fleet.bot.logs":
      return { site: text(query.site), tail: text(query.tail, 12) };
    default:
      return {};
  }
}

/** An authenticated board or agent actor: only they can leave a row, and only they cost a card lookup. */
function hasActor(req: Request): boolean {
  const actor = (req as Request & { actor?: unknown }).actor;
  return isRecord(actor) && (actor.type === "board" || actor.type === "agent");
}

/** Whether the actor of the request is a member of the company (or an instance-wide operator), without side effects. */
function belongsToCompany(req: Request, companyId: string): boolean {
  const actor = (req as Request & { actor?: unknown }).actor;
  if (!isRecord(actor)) return false;
  if (actor.type === "board") {
    if (actor.source === "local_implicit" || actor.isInstanceAdmin === true) return true;
    return Array.isArray(actor.companyIds) && actor.companyIds.includes(companyId);
  }
  if (actor.type === "agent") return actor.companyId === companyId;
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Requests already hooked. A request passes through the audit of every fleet router mounted in front
 * of the one that answers it, and each router has its own audit; the first one to see it records it.
 */
const hooked = new WeakSet<object>();

export function fleetAuditMiddleware(deps: FleetAuditDeps): RequestHandler {
  const now = deps.now ?? Date.now;
  const lastRead = new Map<string, number>();

  async function companyOf(call: AuditedCall, req: Request): Promise<string | null> {
    if (call.company.from === "path") return call.company.id;
    if (call.company.from === "query") {
      return typeof req.query.companyId === "string" ? req.query.companyId.trim() || null : null;
    }
    return UUID.test(call.company.botKey) ? deps.botCompanyId(call.company.botKey) : null;
  }

  async function record(call: AuditedCall, req: Request, status: number): Promise<void> {
    if (!hasActor(req)) return;
    const companyId = await companyOf(call, req);
    if (!companyId || !belongsToCompany(req, companyId)) return;
    const actor = getActorInfo(req);

    const entityId = call.entityId ?? text((isRecord(req.body) ? req.body : {}).name) ?? "unknown";
    if (call.read) {
      const key = `${actor.actorId}|${call.action}|${entityId}`;
      const at = now();
      const before = lastRead.get(key);
      if (before !== undefined && at - before < FLEET_AUDIT_READ_WINDOW_MS) return;
      lastRead.set(key, at);
      if (lastRead.size > 1000) for (const [k, t] of lastRead) if (at - t >= FLEET_AUDIT_READ_WINDOW_MS) lastRead.delete(k);
    }

    await deps.logActivity({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: call.action,
      entityType: call.entityType,
      entityId,
      details: { outcome: outcomeOf(status), status, ...detailsOf(call, req) },
    });
  }

  return (req, res, next) => {
    const call = hooked.has(req) ? null : classifyFleetCall(req.method, (req.originalUrl ?? req.url).split("?")[0]);
    if (call) {
      hooked.add(req);
      res.once("finish", () => {
        void record(call, req, (res as Response).statusCode).catch((err) => {
          deps.log?.warn({ err, action: call.action }, "fleet audit entry was not written");
        });
      });
    }
    next();
  };
}

/** The router with the audit in front of it. Mount it where the router was mounted. */
export function withFleetAudit(router: Router, deps: FleetAuditDeps): Router {
  const wrapped = Router();
  wrapped.use(fleetAuditMiddleware(deps));
  wrapped.use(router);
  return wrapped;
}
