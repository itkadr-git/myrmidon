// server/src/myrmidon/bot-containers/fleetd-driver.ts
//
// myrmidon(FLEETD-VMEXEC): BotContainerDriver client for a `fleetd` service
// running on another machine (the dev bots' host). The board speaks plain HTTP
// over the internal network with a static token (a company secret the operator
// provisions; see MYRMIDON_FLEET_HOSTS in SETTINGS.md); fleetd holds the local
// Docker socket of its host and enforces the same fixed container template the
// dockergate-backed local driver enforces, so this client never sends anything
// the template does not describe: the same BotContainerSpec the reconciler
// already builds for the local driver, and the same CompiledProfile the
// compiler already produces.
//
// Transport notes:
//  - node:http, no new dependency (CONVENTIONS §8). HTTP, because the fleetd
//    host is reachable only over the internal network and terminating TLS there
//    buys nothing the network itself does not already provide; the token is
//    sent as a bearer header and never logged.
//  - Every response body is capped, and a non-2xx answer is an Error with the
//    fleetd status code and reason phrase (fleetd error bodies are one line,
//    produced by the same reason-code discipline as dockergate: no secrets,
//    no host paths).
//  - The profile travels as JSON with file contents inline. Secret files are
//    marked so fleetd never logs them; the request body is bounded by the same
//    limits the local driver's tar path uses.

import http from "node:http";
import https from "node:https";

import { logger } from "../../middleware/logger.js";

import type { BotContainerDriver, BotContainerSpec, BotContainerStatus, TemplateDriftField, TemplateDriftReport } from "./driver.js";
import type { DriverOomEvent } from "./container-oom.js";
import type { CompiledProfile } from "./types.js";

/** The token header fleetd requires on every call. */
const AUTHORIZATION = "authorization";

export const FLEETD_DRIVER_BASE_URL_ENV = "MYRMIDON_FLEET_HOST_URL";
export const FLEETD_DRIVER_TOKEN_ENV = "MYRMIDON_FLEET_HOST_TOKEN";
const DEFAULT_TIMEOUT_MS = 60_000;
/** profileDrift/writeProfile bodies carry the whole profile; allow headroom. */
const BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const START_TIMEOUT_MS = 180_000;

/** Wire format of a mount accepted by fleetd v1 (/bots, /template-drift). */
export interface FleetdWireMount {
  source: string;
  destination: string;
  readOnly?: boolean;
}

/** Wire format of a container spec accepted by fleetd v1 (/bots, /template-drift, /resources). */
export interface FleetdWireSpec {
  botKey: string;
  image: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  network: string;
  mounts?: FleetdWireMount[];
  labels?: Record<string, string>;
  gatewayPort?: number;
  boardExtraHost?: string;
}

/** Wire format of a profile file accepted by fleetd v1 (/bots/:key/profile). */
export interface FleetdWireProfileFile {
  path: string;
  content: string;
  mode: number;
  secret: boolean;
}

/** Wire format of a compiled profile accepted by fleetd v1 (/bots/:key/profile). */
export interface FleetdWireProfile {
  botKey: string;
  files: FleetdWireProfileFile[];
  restartHash: string;
  filesHash: string;
}

/**
 * Maps the internal BotContainerSpec to the strict /v1 wire spec accepted by fleetd.
 * fleetd uses json.Decoder.DisallowUnknownFields, so only fields known to fleetd
 * (botKey, image, cpus, memoryMb, pidsLimit, network, mounts, labels, gatewayPort, boardExtraHost)
 * must be transmitted. extraMounts is mapped to mounts (containerPath -> destination),
 * and board-local fields like sharedMount are stripped.
 */
export function toFleetdWireSpec(spec: BotContainerSpec): FleetdWireSpec {
  const rawMounts = spec.extraMounts ?? (spec as { mounts?: unknown }).mounts;
  const mounts: FleetdWireMount[] | undefined = Array.isArray(rawMounts) && rawMounts.length > 0
    ? rawMounts.map((m: { source: string; destination?: string; containerPath?: string; readOnly?: boolean }) => ({
        source: m.source,
        destination: m.destination ?? m.containerPath ?? "",
        ...(m.readOnly !== undefined ? { readOnly: Boolean(m.readOnly) } : {}),
      }))
    : undefined;

  const wire: FleetdWireSpec = {
    botKey: spec.botKey,
    image: spec.image,
    cpus: spec.cpus,
    memoryMb: spec.memoryMb,
    pidsLimit: spec.pidsLimit,
    network: spec.network,
  };
  if (mounts && mounts.length > 0) wire.mounts = mounts;
  if (spec.labels && Object.keys(spec.labels).length > 0) wire.labels = spec.labels;
  if (typeof (spec as { gatewayPort?: unknown }).gatewayPort === "number") {
    wire.gatewayPort = (spec as { gatewayPort?: number }).gatewayPort;
  }
  if (
    typeof (spec as { boardExtraHost?: unknown }).boardExtraHost === "string" &&
    (spec as { boardExtraHost?: string }).boardExtraHost!.length > 0
  ) {
    wire.boardExtraHost = (spec as { boardExtraHost?: string }).boardExtraHost;
  }
  return wire;
}

/**
 * Maps the internal CompiledProfile to the strict /v1 wire profile accepted by fleetd.
 * Internal board metadata like maxConcurrentRuns or apiServerKeyVersion are stripped
 * to satisfy fleetd's DisallowUnknownFields.
 */
export function toFleetdWireProfile(profile: CompiledProfile, botKeyFallback?: string): FleetdWireProfile {
  return {
    botKey: profile.botKey || botKeyFallback || "",
    files: (profile.files ?? []).map((f) => ({
      path: f.path,
      content: f.content,
      mode: f.mode,
      secret: Boolean(f.secret),
    })),
    restartHash: profile.restartHash ?? "",
    filesHash: profile.filesHash ?? "",
  };
}

export interface FleetdDriverConfig {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  httpsAgent?: https.Agent;
}

export class FleetdDriverError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`fleetd ${status} ${reason}`);
  }
}

export function readFleetdDriverConfig(env: NodeJS.ProcessEnv = process.env): FleetdDriverConfig {
  const baseUrl = env[FLEETD_DRIVER_BASE_URL_ENV]?.trim().replace(/\/+$/, "");
  const token = env[FLEETD_DRIVER_TOKEN_ENV]?.trim();
  if (!baseUrl) throw new Error(`${FLEETD_DRIVER_BASE_URL_ENV} must be set to use the fleetd driver`);
  if (!token) throw new Error(`${FLEETD_DRIVER_TOKEN_ENV} must be set to use the fleetd driver`);
  return { baseUrl, token };
}

interface RawResponse {
  status: number;
  body: Buffer;
}

/** Test hooks and per-instance inputs; every field is optional. */
export interface FleetdDriverOptions {
  request?: (opts: {
    method: string;
    path: string;
    body?: Buffer;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<RawResponse>;
  timeoutMs?: number;
  /**
   * myrmidon(1.6.1-BOT-DISK-B): the instance's shared package cache path, the
   * same reader the local driver gets. A fleetd host never mounts it: the path
   * names a directory on the board's host, fleetd builds its own fixed template
   * (no cache binds), and the profile compiler only points bots on the default
   * host at the cache (profile-compile.ts). So this driver deliberately does
   * nothing with the path and says so once in the server log, rather than
   * leaving an operator to wonder why a fleetd-hosted bot has no shared cache.
   */
  readSharedPackageCachePath?: () => Promise<string | undefined>;
  /** Where that one notice goes; the server logger by default. */
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}

/** The notice logged once per fleetd driver when the instance has a shared package cache. */
export const FLEETD_PACKAGE_CACHE_NOTICE =
  "shared package cache is not applied to bots on a fleetd host: fleetd builds its own container template without the cache binds; these bots keep their per-bot caches";

export interface FleetdEndpoint {
  host: string;
  port: number;
  protocol: "http:" | "https:";
}

/** Parses `http://host[:port]` or `https://host[:port]` into what node:http / node:https wants. */
export function parseFleetdEndpoint(baseUrl: string): FleetdEndpoint {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`fleetd baseUrl must be http:// or https:// (got ${url.protocol}//)`);
  }
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`fleetd baseUrl port is invalid: ${url.port}`);
  return { host: url.hostname, port, protocol: url.protocol as "http:" | "https:" };
}

function fleetdRequest(
  config: FleetdDriverConfig,
  opts: {
    method: string;
    path: string;
    body?: Buffer;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<RawResponse> {
  const endpoint = parseFleetdEndpoint(config.baseUrl);
  const isHttps = endpoint.protocol === "https:";
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.body) headers["Content-Length"] = String(opts.body.length);
    const requestOptions: http.RequestOptions = {
      host: endpoint.host,
      port: endpoint.port,
      path: `/v1${opts.path}`,
      method: opts.method,
      headers,
      timeout: opts.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(isHttps
        ? {
            agent: config.httpsAgent,
            ca: config.caCert,
            cert: config.clientCert,
            key: config.clientKey,
            rejectUnauthorized: true,
          }
        : {}),
    };
    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_LIMIT_BYTES) {
          req.destroy(new Error(`fleetd ${opts.method} ${opts.path}: response body over ${BODY_LIMIT_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => {
      req.destroy(new Error(`fleetd ${opts.method} ${opts.path}: timed out`));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export function fleetdBotContainerDriver(
  config: FleetdDriverConfig,
  options: FleetdDriverOptions = {},
): BotContainerDriver {
  const request = options.request ?? ((opts) => fleetdRequest(config, opts));
  const log = options.log ?? logger;
  let packageCacheNoticeLogged = false;

  /** The explicit no-op of the shared package cache (see FleetdDriverOptions). */
  async function noticeSharedPackageCache(): Promise<void> {
    if (packageCacheNoticeLogged || !options.readSharedPackageCachePath) return;
    let path: string | undefined;
    try {
      path = await options.readSharedPackageCachePath();
    } catch {
      return; // the notice is advisory: a failed settings read must not fail a reconcile
    }
    if (!path) return;
    packageCacheNoticeLogged = true;
    log.warn({ fleetdHost: parseFleetdEndpoint(config.baseUrl).host }, FLEETD_PACKAGE_CACHE_NOTICE);
  }

  async function callJson<T>(opts: {
    method: string;
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<T> {
    const res = await request({
      method: opts.method,
      path: opts.path,
      ...(opts.body === undefined ? {} : { body: Buffer.from(JSON.stringify(opts.body), "utf8") }),
      headers: {
        Accept: "application/json",
        ...(config.token ? { [AUTHORIZATION]: `Bearer ${config.token}` } : {}),
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (res.status >= 400) {
      // One line, fleetd-side discipline; never echo the body (it could hold a secret path).
      throw new FleetdDriverError(res.status, res.body.toString("utf8").slice(0, 200).trim() || "error");
    }
    if (res.body.length === 0) return undefined as T;
    return JSON.parse(res.body.toString("utf8")) as T;
  }

  async function callVoid(opts: { method: string; path: string; body?: unknown; timeoutMs?: number }): Promise<void> {
    await callJson(opts);
  }

  return {
    async status(botKey: string): Promise<BotContainerStatus> {
      return callJson<BotContainerStatus>({ method: "GET", path: `/bots/${encodeURIComponent(botKey)}/status` });
    },

    async list(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
      const res = await callJson<{ bots: BotContainerStatus[] } | BotContainerStatus[]>({
        method: "GET",
        path: "/bots",
      });
      const wanted = new Set(botKeys);
      return (Array.isArray(res) ? res : res.bots).filter((bot) => wanted.has(bot.botKey));
    },

    async templateDrift(spec: BotContainerSpec, _knownStatus?: BotContainerStatus): Promise<TemplateDriftReport> {
      // fleetd answers `drift` and, since the inspect contract, optionally the
      // per-field report; an older fleetd answers only `drift`. The knownStatus
      // hint (OPE-4789) is a local-driver optimization; fleetd's drift call is
      // already one request.
      const res = await callJson<{ drift: boolean; fields?: TemplateDriftField[] }>({
        method: "POST",
        path: `/bots/${encodeURIComponent(spec.botKey)}/template-drift`,
        body: { spec: toFleetdWireSpec(spec) },
      });
      return { drifted: res.drift === true, fields: res.fields ?? [] };
    },

    async updateResources(spec: BotContainerSpec): Promise<void> {
      await callVoid({ method: "POST", path: `/bots/${encodeURIComponent(spec.botKey)}/resources`, body: { spec: toFleetdWireSpec(spec) } });
    },

    async create(spec: BotContainerSpec): Promise<void> {
      await noticeSharedPackageCache();
      await callVoid({ method: "POST", path: "/bots", body: { spec: toFleetdWireSpec(spec) } });
    },

    async recreate(spec: BotContainerSpec): Promise<void> {
      await noticeSharedPackageCache();
      await callVoid({ method: "POST", path: `/bots/${encodeURIComponent(spec.botKey)}/recreate`, body: { spec: toFleetdWireSpec(spec) } });
    },

    async writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
      await callVoid({
        method: "PUT",
        path: `/bots/${encodeURIComponent(botKey)}/profile`,
        body: { profile: toFleetdWireProfile(profile, botKey) },
        timeoutMs: START_TIMEOUT_MS,
      });
    },

    async start(botKey: string): Promise<void> {
      await callVoid({ method: "POST", path: `/bots/${encodeURIComponent(botKey)}/start`, timeoutMs: START_TIMEOUT_MS });
    },

    async restart(botKey: string): Promise<void> {
      await callVoid({ method: "POST", path: `/bots/${encodeURIComponent(botKey)}/restart`, timeoutMs: START_TIMEOUT_MS });
    },

    async stop(botKey: string): Promise<void> {
      await callVoid({
        method: "POST",
        path: `/bots/${encodeURIComponent(botKey)}/stop`,
        timeoutMs: START_TIMEOUT_MS,
      });
    },

    // myrmidon(OPE-12663): IDLE-STOP over the wire. fleetd stops the container
    // and records the idle-stopped mark on its host, so the reconciler leaves
    // the container down and the next wake starts it (the local driver's A17
    // contract). The mark-write failure mode lives fleetd-side: it starts the
    // container back up and answers the error, which surfaces here as-is.
    async stopIdle(botKey: string): Promise<void> {
      await callVoid({
        method: "POST",
        path: `/bots/${encodeURIComponent(botKey)}/stopIdle`,
        timeoutMs: START_TIMEOUT_MS,
      });
    },

    async cleanup(botKey: string): Promise<void> {
      await callVoid({
        method: "POST",
        path: `/bots/${encodeURIComponent(botKey)}/cleanup`,
        timeoutMs: START_TIMEOUT_MS,
      });
    },

    async getOomEvents(sinceNano?: number): Promise<DriverOomEvent[]> {
      const q = sinceNano ? `?since=${sinceNano}` : "";
      return callJson<DriverOomEvent[]>({
        method: "GET",
        path: `/v1/events/oom${q}`,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    },
  };
}
