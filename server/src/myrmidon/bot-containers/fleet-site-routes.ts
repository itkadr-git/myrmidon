// server/src/myrmidon/bot-containers/fleet-site-routes.ts
//
// myrmidon(1.6.6 OPE-8999): the supported way to register an execution site.
//
//   GET    /companies/:companyId/fleet/sites          — list the company's sites (no secret material)
//   POST   /companies/:companyId/fleet/sites          — enroll a site into myrmidon_fleet_sites
//   DELETE /companies/:companyId/fleet/sites/:name    — remove a site
//
// The request carries the fleetd address (https only: fleetd serves mTLS only), the site CA
// (public PEM), and NAMES of company secrets for the bearer token and the client certificate
// and key. No secret value ever passes through this route. Every named secret must already
// exist in the company, so a typo is an error at enroll time, not a silent skip in the
// client manager 30 seconds later.

import { X509Certificate, createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../errors.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdmin } from "../../routes/authz.js";
import { parseTlsCredentials, type FleetSite, type FleetSiteInsert } from "./site-registry.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** "local" is the board's own docker driver; a registered site must not shadow it. */
const RESERVED_NAMES = new Set(["local"]);

const portSchema = z.number().int().min(1024).max(65535);

const enrollBodySchema = z
  .object({
    name: z.string().trim().regex(NAME_PATTERN, "name: lowercase letters, digits, '.', '_', '-'"),
    url: z.string().trim().min(1),
    tokenSecret: z.string().trim().min(1),
    caCert: z.string().trim().min(1),
    /** Optional pin: sha256 of the CA certificate (hex, colons allowed), checked against caCert. */
    caFingerprint: z.string().trim().min(1).optional(),
    /**
     * Secret holding the board's client certificate and key. Either one secret with both PEM
     * blocks (or {"cert","key"} JSON), or a pair named "<ref>-cert" and "<ref>-key".
     */
    clientCertSecretKey: z.string().trim().min(1),
    capacity: z
      .object({
        maxCpus: z.number().positive(),
        maxMemoryMb: z.number().int().positive(),
        maxPids: z.number().int().positive().optional(),
        maxBots: z.number().int().positive().optional(),
      })
      .strict(),
    gatewayPortStart: portSchema,
    gatewayPortEnd: portSchema,
    imageAllowlist: z.array(z.string().trim().min(1)).max(64).optional(),
    hindsightUrl: z.string().trim().min(1).optional(),
    llmBaseUrl: z.string().trim().min(1).optional(),
    boardExtraHost: z.string().trim().min(1).optional(),
    volumeRoot: z.string().trim().min(1).optional(),
    network: z.string().trim().min(1).optional(),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export interface FleetSiteRoutesDeps {
  listSites(companyId: string): Promise<FleetSite[]>;
  getSite(companyId: string, name: string): Promise<FleetSite | null>;
  createSite(input: FleetSiteInsert): Promise<FleetSite>;
  deleteSite(companyId: string, name: string): Promise<boolean>;
  /** Number of bots whose card names this site as container.host. */
  countBotsOnSite(companyId: string, name: string): Promise<number>;
  /** The CA PEM of a company secret (or null): used to cross-check the enrolled CA. */
  readSecret(companyId: string, name: string): Promise<string | null>;
  /** True when a company secret with this exact name exists. */
  secretExists(companyId: string, name: string): Promise<boolean>;
}

/** The https URL of a fleetd, reduced to origin; throws a message fit for a 400. */
export function normalizeFleetdUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("url: not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("url: must be https:// (fleetd serves mTLS only)");
  }
  if (parsed.username || parsed.password) throw new Error("url: credentials in the URL are not allowed");
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("url: expected scheme://host[:port] only");
  }
  return parsed.origin;
}

/** Parses the site CA PEM; returns the PEM (as given) and the sha256 fingerprint of its DER. */
export function inspectCaCert(pem: string): { fingerprint: string } {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new Error("caCert: not a PEM certificate");
  }
  return { fingerprint: createHash("sha256").update(cert.raw).digest("hex") };
}

function normalizeFingerprint(raw: string): string {
  return raw.replace(/[:\s]/g, "").toLowerCase();
}

/**
 * Reads the client certificate the board will present (same lookup order as the client manager)
 * and checks that the site CA signed it. `error` is a message for a 400, or null when it is fine or
 * when the secret cannot be read as a certificate here (the manager then reports it). `notAfter` is
 * the end of the certificate's validity: the key's TTL the fleet screen shows (null when unreadable).
 */
async function inspectClientCert(
  deps: FleetSiteRoutesDeps,
  companyId: string,
  ref: string,
  caPem: string,
  now: Date,
): Promise<{ error: string | null; notAfter: Date | null }> {
  let cert: string | undefined;
  for (const name of [ref, `${ref}-cert`, `${ref}_cert`]) {
    const raw = await deps.readSecret(companyId, name);
    if (!raw) continue;
    cert = parseTlsCredentials(raw).cert;
    if (cert) break;
  }
  if (!cert) return { error: null, notAfter: null };
  try {
    const leaf = new X509Certificate(cert);
    if (!leaf.verify(new X509Certificate(caPem).publicKey)) {
      return { error: "clientCertSecretKey: the client certificate is not signed by caCert", notAfter: null };
    }
    const notAfter = new Date(leaf.validTo);
    if (Number.isNaN(notAfter.getTime())) return { error: null, notAfter: null };
    if (notAfter.getTime() <= now.getTime()) {
      return { error: `clientCertSecretKey: the client certificate expired at ${notAfter.toISOString()}`, notAfter };
    }
    return { error: null, notAfter };
  } catch {
    return { error: "clientCertSecretKey: the client certificate is not a valid PEM certificate", notAfter: null };
  }
}

/**
 * The client manager reads the certificate and key from one secret named by the reference
 * (PEM blocks or {"cert","key"} JSON), or from a "<ref>-cert" + "<ref>-key" pair
 * ("_cert"/"_key" also work). Enroll accepts exactly those shapes.
 */
async function clientMaterialExists(deps: FleetSiteRoutesDeps, companyId: string, ref: string): Promise<boolean> {
  if (await deps.secretExists(companyId, ref)) return true;
  for (const sep of ["-", "_"]) {
    if ((await deps.secretExists(companyId, `${ref}${sep}cert`)) && (await deps.secretExists(companyId, `${ref}${sep}key`))) {
      return true;
    }
  }
  return false;
}

function publicSite(site: FleetSite) {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    status: site.status,
    tokenSecret: site.tokenSecret ?? null,
    clientCertSecretKey: site.clientCertSecretKey ?? null,
    clientCertNotAfter: site.clientCertNotAfter ? new Date(site.clientCertNotAfter).toISOString() : null,
    caCertFingerprint: site.caCertFingerprint ?? null,
    capacity: site.capacity,
    profile: site.profile,
    labels: site.labels ?? {},
    enrolledAt: site.enrolledAt,
    lastSeenAt: site.lastSeenAt ?? null,
  };
}

export function fleetSiteRoutes(deps: FleetSiteRoutesDeps): Router {
  const router = Router();

  function companyOf(req: Request, admin = false): string {
    assertBoard(req);
    const companyId = typeof req.params.companyId === "string" ? req.params.companyId : "";
    if (!companyId) throw badRequest("companyId required");
    if (admin) assertCompanyAdmin(req, companyId);
    else assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function handleList(req: Request, res: Response): Promise<void> {
    const companyId = companyOf(req);
    const sites = await deps.listSites(companyId);
    res.json({ sites: sites.map(publicSite) });
  }

  async function handleEnroll(req: Request, res: Response): Promise<void> {
    const companyId = companyOf(req, true);
    const parsed = enrollBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(`Invalid site enrollment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    const body = parsed.data;

    if (RESERVED_NAMES.has(body.name)) throw badRequest(`name: "${body.name}" is reserved`);
    if (body.gatewayPortEnd < body.gatewayPortStart) throw badRequest("gatewayPortEnd must be >= gatewayPortStart");
    if (body.capacity.maxBots !== undefined) {
      const ports = body.gatewayPortEnd - body.gatewayPortStart + 1;
      if (body.capacity.maxBots > ports) {
        throw badRequest(`capacity.maxBots (${body.capacity.maxBots}) exceeds the gateway port range (${ports} ports)`);
      }
    }

    let url: string;
    let fingerprint: string;
    try {
      url = normalizeFleetdUrl(body.url);
      fingerprint = inspectCaCert(body.caCert).fingerprint;
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "invalid site enrollment");
    }

    if (body.caFingerprint && normalizeFingerprint(body.caFingerprint) !== fingerprint) {
      throw badRequest("caFingerprint: does not match the sha256 of caCert");
    }

    if (!(await deps.secretExists(companyId, body.tokenSecret))) {
      throw badRequest(`tokenSecret: company secret "${body.tokenSecret}" not found`);
    }
    if (!(await clientMaterialExists(deps, companyId, body.clientCertSecretKey))) {
      throw badRequest(
        `clientCertSecretKey: no company secret "${body.clientCertSecretKey}" (or "-cert" + "-key" pair) found`,
      );
    }

    const clientCert = await inspectClientCert(deps, companyId, body.clientCertSecretKey, body.caCert, new Date());
    if (clientCert.error) throw badRequest(clientCert.error);

    if (await deps.getSite(companyId, body.name)) throw conflict(`Site "${body.name}" is already enrolled`);

    const profile: FleetSite["profile"] = {
      gatewayPortStart: body.gatewayPortStart,
      gatewayPortEnd: body.gatewayPortEnd,
      ...(body.imageAllowlist ? { imageAllowlist: body.imageAllowlist } : {}),
      ...(body.hindsightUrl ? { hindsightUrl: body.hindsightUrl } : {}),
      ...(body.llmBaseUrl ? { llmBaseUrl: body.llmBaseUrl } : {}),
      ...(body.boardExtraHost ? { boardExtraHost: body.boardExtraHost } : {}),
      ...(body.volumeRoot ? { volumeRoot: body.volumeRoot } : {}),
      ...(body.network ? { network: body.network } : {}),
    };

    const created = await deps.createSite({
      companyId,
      name: body.name,
      url,
      tokenSecret: body.tokenSecret,
      caCert: body.caCert,
      caCertFingerprint: fingerprint,
      clientCertSecretKey: body.clientCertSecretKey,
      clientCertNotAfter: clientCert.notAfter,
      status: "active",
      capacity: body.capacity,
      profile,
      labels: body.labels ?? {},
    });
    res.status(201).json({ site: publicSite(created) });
  }

  async function handleDelete(req: Request, res: Response): Promise<void> {
    const companyId = companyOf(req, true);
    const name = typeof req.params.name === "string" ? req.params.name : "";
    if (!name) throw badRequest("name required");
    const bots = await deps.countBotsOnSite(companyId, name);
    if (bots > 0) {
      throw conflict(`Site "${name}" still hosts ${bots} bot(s): move them off (container.host) before removing it`);
    }
    if (!(await deps.deleteSite(companyId, name))) throw notFound(`Site "${name}" not found`);
    res.status(204).end();
  }

  router.get("/companies/:companyId/fleet/sites", (req, res, next) => {
    void handleList(req, res).catch(next);
  });
  router.post("/companies/:companyId/fleet/sites", (req, res, next) => {
    void handleEnroll(req, res).catch(next);
  });
  router.delete("/companies/:companyId/fleet/sites/:name", (req, res, next) => {
    void handleDelete(req, res).catch(next);
  });

  return router;
}
