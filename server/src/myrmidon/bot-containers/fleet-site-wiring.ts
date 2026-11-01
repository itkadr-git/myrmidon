// server/src/myrmidon/bot-containers/fleet-site-wiring.ts
//
// myrmidon(1.6.6 OPE-8999): binds the site enroll routes to the registry and company secrets.
// myrmidon(1.6.6 OPE-9154): the board issues the site client certificate itself: the site-CA
// key material is generated here, stored only as a company secret, and never returned.

import { X509Certificate, createPrivateKey } from "node:crypto";
import type { Router } from "express";
import { myrmidonFleetSites, type Db } from "@myrmidon/db";
import { secretService } from "../../services/index.js";
import { siteCaSubject } from "./site-client-pki.js";
import {
  fleetSiteRoutes,
  rotateDueFleetSiteCertificates,
  startFleetSiteCertRotationScheduler,
  type FleetSiteRoutesDeps,
} from "./fleet-site-routes.js";
import { siteHealthStore } from "./site-health-store.js";
import { createFleetSite, deleteFleetSite, getFleetSite, listFleetSites, parseTlsCredentials, updateFleetSite, bumpFleetRegistryVersion } from "./site-registry.js";

export function createFleetSiteRoutesDeps(db: Db): FleetSiteRoutesDeps {
  const secrets = secretService(db);
  const health = siteHealthStore(db);
  return {
    listSites: (companyId) => listFleetSites(db, companyId),
    getSite: (companyId, name) => getFleetSite(db, companyId, name),
    createSite: (input) => createFleetSite(db, input),
    deleteSite: (companyId, name) => deleteFleetSite(db, companyId, name),
    countBotsOnSite: async (companyId, name) => (await health.listBotsOnSite(companyId, name)).length,
    readSecret: async (companyId, name) => {
      const secret = await secrets.getByName(companyId, name);
      return secret ? secrets.resolveSecretValue(companyId, secret.id, "latest") : null;
    },
    readSiteCa: async (companyId) => {
      const secret = await secrets.getByName(companyId, "myrmidon-site-ca");
      if (!secret) return null;
      const raw = await secrets.resolveSecretValue(companyId, secret.id, "latest");
      if (!raw) throw new Error("Stored site CA secret cannot be resolved");
      let material: { cert?: unknown; key?: unknown };
      try { material = JSON.parse(raw) as { cert?: unknown; key?: unknown }; } catch { throw new Error("Stored site CA secret is malformed"); }
      if (typeof material.cert !== "string" || typeof material.key !== "string") throw new Error("Stored site CA secret is malformed");
      const cert = new X509Certificate(material.cert);
      const key = createPrivateKey(material.key);
      if (!cert.ca || !cert.checkPrivateKey(key)) throw new Error("Stored site CA secret is malformed");
      return { cert: material.cert, key: material.key, subject: siteCaSubject(material.cert) };
    },
    secretExists: async (companyId, name) => Boolean(await secrets.getByName(companyId, name)),
    writeSecret: async (companyId, name, value) => {
      const existing = await secrets.getByName(companyId, name);
      if (existing) await secrets.rotate(existing.id, { value });
      else await secrets.create(companyId, { name, provider: "local_encrypted", value });
    },
    deleteSecret: async (companyId, name) => {
      const existing = await secrets.getByName(companyId, name);
      if (existing) {
        await secrets.remove(existing.id);
      }
    },
    refreshRegistry: () => { bumpFleetRegistryVersion(); },
    updateSite: async (companyId, name, patch) => {
      await updateFleetSite(db, companyId, name, patch);
    },
    readClientCertificate: async (companyId, name) => {
      const secret = await secrets.getByName(companyId, name);
      if (!secret) return null;
      const raw = await secrets.resolveSecretValue(companyId, secret.id, "latest");
      return raw ? parseTlsCredentials(raw).cert ?? null : null;
    },
  };
}

export function myrmidonFleetSiteRoutes(db: Db): Router {
  return fleetSiteRoutes(createFleetSiteRoutesDeps(db));
}

export function startFleetSiteCertRotation(
  db: Db,
  opts: {
    env?: NodeJS.ProcessEnv;
    intervalMs?: number;
    log?: { info(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
  } = {},
): () => void {
  const deps = createFleetSiteRoutesDeps(db);
  const scheduler = startFleetSiteCertRotationScheduler({
    listCompanies: async () => {
      const rows = await db.selectDistinct({ companyId: myrmidonFleetSites.companyId }).from(myrmidonFleetSites);
      return rows.map((r) => r.companyId);
    },
    rotateCompany: (companyId) => rotateDueFleetSiteCertificates(deps, companyId),
    intervalMs: opts.intervalMs ?? 60_000,
    log: opts.log,
  });
  return () => scheduler.stop();
}
