// server/src/myrmidon/bot-containers/site-registry.ts
//
// myrmidon(1.6.6 T1): Remote sites registry, CRUD, env bootstrap, and
// dynamic FleetClientManager for mTLS and hot-reload.

import https from "node:https";
import type { Db } from "@paperclipai/db";
import {
  companies,
  myrmidonFleetSites,
  myrmidonFleetAffinity,
  type FleetSiteCapacity,
  type FleetSiteProfile,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../../services/index.js";
import type { BotContainerDriver } from "./driver.js";
import { fleetdBotContainerDriver, type FleetdDriverConfig } from "./fleetd-driver.js";
import { fleetSiteKey, parseFleetHosts, type FleetHostConfig } from "./fleetd-hosts.js";

let fleetRegistryVersion = 1;

export function getFleetRegistryVersion(): number {
  return fleetRegistryVersion;
}

export function bumpFleetRegistryVersion(): number {
  return ++fleetRegistryVersion;
}

export interface FleetSite {
  id: string;
  companyId: string;
  name: string;
  url: string;
  tokenSecret?: string | null;
  caCert?: string | null;
  caCertFingerprint?: string | null;
  clientCert?: string | null;
  clientCertSecretKey?: string | null;
  clientCertNotAfter?: Date | null;
  status: string;
  capacity: FleetSiteCapacity;
  profile: FleetSiteProfile;
  labels?: Record<string, string> | null;
  enrolledAt: Date;
  lastSeenAt?: Date | null;
  certRotatedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FleetSiteInsert {
  companyId: string;
  name: string;
  url: string;
  tokenSecret?: string | null;
  caCert?: string | null;
  caCertFingerprint?: string | null;
  clientCert?: string | null;
  clientCertSecretKey?: string | null;
  clientCertNotAfter?: Date | null;
  status?: string;
  capacity?: FleetSiteCapacity;
  profile?: FleetSiteProfile;
  labels?: Record<string, string> | null;
}

export type FleetSiteUpdate = Partial<Omit<FleetSiteInsert, "companyId" | "name">>;

export interface FleetAffinity {
  id: string;
  companyId: string;
  scope: string; // "project" | "company" | "agent"
  targetId: string;
  siteName: string;
  weight: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FleetAffinityInsert {
  companyId: string;
  scope: string;
  targetId: string;
  siteName: string;
  weight?: number;
}

export async function createFleetSite(db: Db, input: FleetSiteInsert): Promise<FleetSite> {
  const [created] = await db
    .insert(myrmidonFleetSites)
    .values({
      companyId: input.companyId,
      name: input.name,
      url: input.url,
      tokenSecret: input.tokenSecret ?? null,
      caCert: input.caCert ?? null,
      caCertFingerprint: input.caCertFingerprint ?? null,
      clientCert: input.clientCert ?? null,
      clientCertSecretKey: input.clientCertSecretKey ?? null,
      clientCertNotAfter: input.clientCertNotAfter ?? null,
      status: input.status ?? "active",
      capacity: input.capacity ?? { maxCpus: 8, maxMemoryMb: 32768 },
      profile: input.profile ?? {},
      labels: input.labels ?? {},
    })
    .returning();
  bumpFleetRegistryVersion();
  return created as unknown as FleetSite;
}

export async function getFleetSite(db: Db, companyId: string, name: string): Promise<FleetSite | null> {
  const rows = await db
    .select()
    .from(myrmidonFleetSites)
    .where(and(eq(myrmidonFleetSites.companyId, companyId), eq(myrmidonFleetSites.name, name)))
    .limit(1);
  return (rows[0] as unknown as FleetSite) ?? null;
}

export async function listFleetSites(db: Db, companyId?: string): Promise<FleetSite[]> {
  const query = db.select().from(myrmidonFleetSites);
  const rows = companyId
    ? await query.where(eq(myrmidonFleetSites.companyId, companyId))
    : await query;
  return rows as unknown as FleetSite[];
}

export async function updateFleetSite(
  db: Db,
  companyId: string,
  name: string,
  patch: FleetSiteUpdate,
): Promise<FleetSite | null> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (patch.url !== undefined) updateData.url = patch.url;
  if (patch.tokenSecret !== undefined) updateData.tokenSecret = patch.tokenSecret;
  if (patch.caCert !== undefined) updateData.caCert = patch.caCert;
  if (patch.caCertFingerprint !== undefined) updateData.caCertFingerprint = patch.caCertFingerprint;
  if (patch.clientCert !== undefined) updateData.clientCert = patch.clientCert;
  if (patch.clientCertSecretKey !== undefined) updateData.clientCertSecretKey = patch.clientCertSecretKey;
  if (patch.clientCertNotAfter !== undefined) updateData.clientCertNotAfter = patch.clientCertNotAfter;
  if (patch.status !== undefined) updateData.status = patch.status;
  if (patch.capacity !== undefined) updateData.capacity = patch.capacity;
  if (patch.profile !== undefined) updateData.profile = patch.profile;
  if (patch.labels !== undefined) updateData.labels = patch.labels;

  const [updated] = await db
    .update(myrmidonFleetSites)
    .set(updateData)
    .where(and(eq(myrmidonFleetSites.companyId, companyId), eq(myrmidonFleetSites.name, name)))
    .returning();
  if (updated) {
    bumpFleetRegistryVersion();
    return updated as unknown as FleetSite;
  }
  return null;
}

export async function deleteFleetSite(db: Db, companyId: string, name: string): Promise<boolean> {
  const deleted = await db
    .delete(myrmidonFleetSites)
    .where(and(eq(myrmidonFleetSites.companyId, companyId), eq(myrmidonFleetSites.name, name)))
    .returning({ id: myrmidonFleetSites.id });
  if (deleted.length > 0) {
    bumpFleetRegistryVersion();
    return true;
  }
  return false;
}

export async function createFleetAffinity(db: Db, input: FleetAffinityInsert): Promise<FleetAffinity> {
  const [created] = await db
    .insert(myrmidonFleetAffinity)
    .values({
      companyId: input.companyId,
      scope: input.scope,
      targetId: input.targetId,
      siteName: input.siteName,
      weight: input.weight ?? 100,
    })
    .returning();
  return created as unknown as FleetAffinity;
}

export async function listFleetAffinities(
  db: Db,
  companyId: string,
  scope?: string,
  targetId?: string,
): Promise<FleetAffinity[]> {
  const rows = await db
    .select()
    .from(myrmidonFleetAffinity)
    .where(eq(myrmidonFleetAffinity.companyId, companyId));
  return rows.filter((r) => {
    if (scope && r.scope !== scope) return false;
    if (targetId && r.targetId !== targetId) return false;
    return true;
  }) as unknown as FleetAffinity[];
}

export async function deleteFleetAffinity(db: Db, companyId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(myrmidonFleetAffinity)
    .where(and(eq(myrmidonFleetAffinity.companyId, companyId), eq(myrmidonFleetAffinity.id, id)))
    .returning({ id: myrmidonFleetAffinity.id });
  return deleted.length > 0;
}

export async function bootstrapFleetSitesFromEnv(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  log?: {
    warn?(f: object, m: string): void;
    info?(f: object, m: string): void;
    error?(f: object, m: string): void;
  },
): Promise<{ inserted: number; updated: number }> {
  const raw = env.MYRMIDON_FLEET_HOSTS;
  if (!raw || !raw.trim()) return { inserted: 0, updated: 0 };

  const logWarn = (f: object, m: string) => {
    if (log && typeof log.warn === "function") log.warn(f, m);
    else if (log && typeof log.info === "function") log.info(f, m);
    else logger.warn(f, m);
  };

  let hostConfigs: Map<string, FleetHostConfig>;
  try {
    hostConfigs = parseFleetHosts(raw);
  } catch (err) {
    logWarn({ err }, "failed to parse MYRMIDON_FLEET_HOSTS for site bootstrap; skipping");
    return { inserted: 0, updated: 0 };
  }

  if (hostConfigs.size === 0) return { inserted: 0, updated: 0 };

  let companyRows: { id: string }[];
  try {
    companyRows = await db.select({ id: companies.id }).from(companies);
  } catch (err) {
    logWarn({ err }, "failed to read companies for fleet site bootstrap; skipping");
    return { inserted: 0, updated: 0 };
  }

  let inserted = 0;
  let updated = 0;

  for (const company of companyRows) {
    for (const host of hostConfigs.values()) {
      try {
        const existing = await getFleetSite(db, company.id, host.name);
        const profile: FleetSiteProfile = {};
        if (host.hindsightUrl) profile.hindsightUrl = host.hindsightUrl;
        if (host.llmBaseUrl) profile.llmBaseUrl = host.llmBaseUrl;
        if (host.boardExtraHost) profile.boardExtraHost = host.boardExtraHost;
        if (host.volumeRoot) profile.volumeRoot = host.volumeRoot;
        if (host.network) profile.network = host.network;
        if (host.imageAllowlist) profile.imageAllowlist = [...host.imageAllowlist];

        if (existing) {
          await updateFleetSite(db, company.id, host.name, {
            url: host.url,
            tokenSecret: host.tokenSecret,
            profile,
          });
          updated++;
        } else {
          await createFleetSite(db, {
            companyId: company.id,
            name: host.name,
            url: host.url,
            tokenSecret: host.tokenSecret,
            status: "active",
            profile,
          });
          inserted++;
        }
      } catch (err) {
        logWarn({ err, companyId: company.id, host: host.name }, "failed to bootstrap fleet site");
      }
    }
  }

  return { inserted, updated };
}

export interface FleetClientManagerDeps {
  db: Db;
  readCompanySecret?: (companyId: string, name: string) => Promise<string | null>;
  createDriver?: (config: FleetdDriverConfig) => BotContainerDriver;
  log?: {
    info?(fields: Record<string, unknown>, message: string): void;
    warn?(fields: Record<string, unknown>, message: string): void;
    error?(fields: Record<string, unknown>, message: string): void;
  };
}

export interface FleetClientManager {
  getClients(): ReadonlyMap<string, BotContainerDriver>;
  refresh(): Promise<ReadonlyMap<string, BotContainerDriver>>;
  getVersion(): number;
  close(): void;
}

export function parseTlsCredentials(raw: string): { cert?: string; key?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        const cert = parsed.cert ?? parsed.certificate ?? parsed.clientCert;
        const key = parsed.key ?? parsed.privateKey ?? parsed.clientKey;
        return {
          cert: typeof cert === "string" ? cert.trim() : undefined,
          key: typeof key === "string" ? key.trim() : undefined,
        };
      }
    } catch {
      // not JSON, fallback to PEM
    }
  }

  const certMatches = trimmed.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  const keyMatches = trimmed.match(/-----BEGIN [A-Z\s]*KEY-----[\s\S]+?-----END [A-Z\s]*KEY-----/g);

  if (certMatches || keyMatches) {
    return {
      cert: certMatches ? certMatches.join("\n") : undefined,
      key: keyMatches ? keyMatches[0] : undefined,
    };
  }

  const upper = trimmed.toUpperCase();
  const result: { cert?: string; key?: string } = {};
  if (upper.includes("CERT")) result.cert = trimmed;
  if (upper.includes("KEY")) result.key = trimmed;
  if (result.cert || result.key) return result;

  return { key: trimmed };
}

export function createFleetClientManager(deps: FleetClientManagerDeps): FleetClientManager {
  const log = deps.log ?? logger;
  const logWarn = (fields: Record<string, unknown>, message: string) => {
    if (deps.log && typeof deps.log.warn === "function") deps.log.warn(fields, message);
    else if (deps.log && typeof deps.log.info === "function") deps.log.info(fields, message);
    else logger.warn(fields, message);
  };
  const clients = new Map<string, BotContainerDriver>();
  const clientFingerprints = new Map<string, string>();
  const agentsToClose: https.Agent[] = [];

  const resolveSecret =
    deps.readCompanySecret ??
    (async (companyId: string, name: string): Promise<string | null> => {
      try {
        const secrets = secretService(deps.db);
        const secret = await secrets.getByName(companyId, name);
        if (!secret) return null;
        return secrets.resolveSecretValue(companyId, secret.id, "latest");
      } catch (err) {
        logWarn({ err, companyId, name }, "failed to resolve company secret for fleet site");
        return null;
      }
    });

  const createDriver = deps.createDriver ?? fleetdBotContainerDriver;

  async function refresh(): Promise<ReadonlyMap<string, BotContainerDriver>> {
    try {
      const sites = await listFleetSites(deps.db);
      const activeSites = sites.filter((s) => s.status === "active");
      const activeNames = new Set<string>();

      for (const site of activeSites) {
        const key = fleetSiteKey(site.companyId, site.name);
        activeNames.add(key);
        const fingerprint = `${site.url}|${site.tokenSecret ?? ""}|${site.caCert ?? ""}|${site.clientCert ?? ""}|${site.clientCertSecretKey ?? ""}`;
        if (clients.has(key) && clientFingerprints.get(key) === fingerprint) {
          continue;
        }

        let token: string | undefined;
        if (site.tokenSecret) {
          const resolved = await resolveSecret(site.companyId, site.tokenSecret);
          if (resolved) token = resolved;
        }

        let clientCert: string | undefined = site.clientCert ?? undefined;
        let clientKey: string | undefined;

        if (site.clientCertSecretKey) {
          const resolved = await resolveSecret(site.companyId, site.clientCertSecretKey);
          if (resolved) {
            const parsed = parseTlsCredentials(resolved);
            if (parsed.cert && !clientCert) clientCert = parsed.cert;
            if (parsed.key) clientKey = parsed.key;
          }

          if (!clientCert) {
            const candidateNames = [
              site.clientCertSecretKey.endsWith("-key") ? site.clientCertSecretKey.replace(/-key$/, "-cert") : null,
              site.clientCertSecretKey.endsWith("_key") ? site.clientCertSecretKey.replace(/_key$/, "_cert") : null,
              `${site.clientCertSecretKey}-cert`,
              `${site.clientCertSecretKey}_cert`,
            ].filter((n): n is string => Boolean(n && n !== site.clientCertSecretKey));

            for (const cand of candidateNames) {
              const resolvedCert = await resolveSecret(site.companyId, cand);
              if (resolvedCert) {
                const parsed = parseTlsCredentials(resolvedCert);
                if (parsed.cert) {
                  clientCert = parsed.cert;
                  break;
                }
              }
            }
          }

          if (!clientKey) {
            const candidateNames = [
              site.clientCertSecretKey.endsWith("-cert") ? site.clientCertSecretKey.replace(/-cert$/, "-key") : null,
              site.clientCertSecretKey.endsWith("_cert") ? site.clientCertSecretKey.replace(/_cert$/, "_key") : null,
              `${site.clientCertSecretKey}-key`,
              `${site.clientCertSecretKey}_key`,
            ].filter((n): n is string => Boolean(n && n !== site.clientCertSecretKey));

            for (const cand of candidateNames) {
              const resolvedKey = await resolveSecret(site.companyId, cand);
              if (resolvedKey) {
                const parsed = parseTlsCredentials(resolvedKey);
                if (parsed.key) {
                  clientKey = parsed.key;
                  break;
                }
              }
            }
          }
        }

        let httpsAgent: https.Agent | undefined;
        const isHttps = site.url.startsWith("https:");
        if (isHttps || site.caCert || clientKey || clientCert) {
          httpsAgent = new https.Agent({
            ca: site.caCert ?? undefined,
            cert: clientCert ?? undefined,
            key: clientKey ?? undefined,
            rejectUnauthorized: true,
          });
          agentsToClose.push(httpsAgent);
        }

        const driverConfig: FleetdDriverConfig = {
          baseUrl: site.url,
          ...(token ? { token } : {}),
          ...(site.caCert ? { caCert: site.caCert } : {}),
          ...(clientCert ? { clientCert } : {}),
          ...(clientKey ? { clientKey } : {}),
          ...(httpsAgent ? { httpsAgent } : {}),
        };

        const driver = createDriver(driverConfig);
        clients.set(key, driver);
        clientFingerprints.set(key, fingerprint);
      }

      // Remove inactive or deleted sites
      for (const name of Array.from(clients.keys())) {
        if (!activeNames.has(name)) {
          clients.delete(name);
          clientFingerprints.delete(name);
        }
      }
    } catch (err) {
      if (deps.log && typeof deps.log.error === "function") {
        deps.log.error({ err }, "failed to refresh fleet sites from registry; keeping existing clients");
      } else {
        logger.error({ err }, "failed to refresh fleet sites from registry; keeping existing clients");
      }
    }
    return clients;
  }

  function getClients(): ReadonlyMap<string, BotContainerDriver> {
    return clients;
  }

  function getVersion(): number {
    return getFleetRegistryVersion();
  }

  function close(): void {
    for (const agent of agentsToClose) {
      agent.destroy();
    }
    agentsToClose.length = 0;
    clients.clear();
    clientFingerprints.clear();
  }

  return {
    getClients,
    refresh,
    getVersion,
    close,
  };
}
