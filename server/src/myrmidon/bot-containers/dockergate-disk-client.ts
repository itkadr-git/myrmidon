// server/src/myrmidon/bot-containers/dockergate-disk-client.ts
//
// myrmidon(1.6.5-BOT-DISK-H9c): the board's client of the dockergate disk routes
// of contract C5 (docs/myrmidon/bot-disk-contract): `GET /myrmidon/disk` (A14)
// reads the physical numbers of the bot partition, `PUT /myrmidon/disk/<botKey>/quota`
// (A15) sets a bot's hard xfs project quota. Both go over the same unix socket
// as the docker driver (MYRMIDON_BOT_DOCKER_SOCKET), and both answers are parsed
// with the shared C5 schemas, so a dockergate that drifts from the contract fails
// here loudly instead of feeding wrong numbers into signals.
//
// The client never throws into a scheduler tick on its own: callers catch
// DockergateDiskError. A short cache on GET keeps the admission check (one read
// per new clone) from becoming a request storm on a gate that already has a
// rate limit (OPE-4752).

import http from "node:http";
import {
  wsDiskApiResponseSchema,
  wsDiskQuotaPutRequestSchema,
  wsDiskQuotaPutResponseSchema,
  type WsDiskApiResponse,
  type WsDiskQuotaPutResponse,
} from "@paperclipai/shared";

export const BOT_DOCKER_SOCKET_ENV_NAME = "MYRMIDON_BOT_DOCKER_SOCKET";
export const DEFAULT_DOCKERGATE_SOCKET = "/var/run/docker.sock";

const REQUEST_TIMEOUT_MS = 5_000;
/** GET /myrmidon/disk is reused within this window. */
export const DOCKERGATE_DISK_CACHE_TTL_MS = 5_000;

export class DockergateDiskError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the gate could not be reached. */
    readonly status: number,
    /** The stable deny code of the answer (WS_DOCKERGATE_DENY), when it had one. */
    readonly denyCode: string | null = null,
  ) {
    super(message);
    this.name = "DockergateDiskError";
  }
}

export interface DockergateDiskClient {
  /** The physical disk state; cached for a few seconds. */
  getDisk(): Promise<WsDiskApiResponse>;
  /** Sets the hard quota of one bot, in bytes (validated against the C5 bounds). */
  putQuota(botKey: string, bytes: number): Promise<WsDiskQuotaPutResponse>;
}

export interface DockergateHttpResponse {
  status: number;
  body: string;
}

export type DockergateTransport = (request: {
  method: "GET" | "PUT";
  path: string;
  body?: string;
}) => Promise<DockergateHttpResponse>;

function socketTransport(socketPath: string): DockergateTransport {
  return (request) =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (request.body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(request.body));
      }
      const req = http.request({ socketPath, path: request.path, method: request.method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`dockergate ${request.method} ${request.path} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });
      req.on("error", reject);
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
}

function denyCodeOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.code === "string") return parsed.code;
  } catch {
    /* not JSON: no code */
  }
  return null;
}

export function createDockergateDiskClient(options: {
  socketPath?: string;
  /** Tests inject a transport; production uses the unix socket. */
  transport?: DockergateTransport;
  now?: () => number;
  cacheTtlMs?: number;
}): DockergateDiskClient {
  const transport = options.transport ?? socketTransport(options.socketPath ?? DEFAULT_DOCKERGATE_SOCKET);
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? DOCKERGATE_DISK_CACHE_TTL_MS;
  let cached: { at: number; value: WsDiskApiResponse } | null = null;
  let inFlight: Promise<WsDiskApiResponse> | null = null;

  async function call(request: Parameters<DockergateTransport>[0]): Promise<DockergateHttpResponse> {
    let res: DockergateHttpResponse;
    try {
      res = await transport(request);
    } catch (error) {
      throw new DockergateDiskError(
        `dockergate ${request.method} ${request.path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new DockergateDiskError(
        `dockergate ${request.method} ${request.path} failed: ${res.status} ${res.body.slice(0, 200)}`,
        res.status,
        denyCodeOf(res.body),
      );
    }
    return res;
  }

  function parse<T>(what: string, body: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new DockergateDiskError(`dockergate ${what}: the answer is not JSON`, 200);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new DockergateDiskError(`dockergate ${what}: the answer does not match contract C5`, 200);
    return parsed.data;
  }

  return {
    async getDisk() {
      if (cached && now() - cached.at < ttl) return cached.value;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const res = await call({ method: "GET", path: "/myrmidon/disk" });
        const value = parse("GET /myrmidon/disk", res.body, wsDiskApiResponseSchema);
        cached = { at: now(), value };
        return value;
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async putQuota(botKey, bytes) {
      const body = wsDiskQuotaPutRequestSchema.parse({ bytes });
      const res = await call({
        method: "PUT",
        path: `/myrmidon/disk/${encodeURIComponent(botKey)}/quota`,
        body: JSON.stringify(body),
      });
      cached = null; // the next read must see the new hard limit
      return parse(`PUT quota of ${botKey}`, res.body, wsDiskQuotaPutResponseSchema);
    },
  };
}

/** The client of this process, from the same socket variable the docker driver reads. */
export function dockergateDiskClientFromEnv(env: NodeJS.ProcessEnv = process.env): DockergateDiskClient {
  return createDockergateDiskClient({
    socketPath: env[BOT_DOCKER_SOCKET_ENV_NAME]?.trim() || DEFAULT_DOCKERGATE_SOCKET,
  });
}
