// server/src/myrmidon/bot-containers/site-agent-test-adapter.ts
//
// myrmidon(1.6.6 T10-A): Test adapter connecting board/harness to the site-agent.
// Fulfills the requirement: "Подключение к будущему site-agent — через test adapter,
// не вторая реализация его сервера."
//
// The test adapter is a client component that terminates mTLS and communicates
// with the site-agent over HTTP/HTTPS, executing operations against the real
// remote agent endpoint without reimplementing the server daemon in tests.

import http from "node:http";
import https from "node:https";
import type { BotContainerSpec, BotContainerStatus, TemplateDriftReport } from "./driver.js";
import type { CompiledProfile } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;
const BODY_LIMIT_BYTES = 64 * 1024 * 1024;

export interface SiteAgentTestAdapterConfig {
  baseUrl: string;
  token?: string;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface SiteAgentTestAdapter {
  readonly endpoint: string;
  health(): Promise<{ status: string; [key: string]: unknown }>;
  status(botKey: string): Promise<BotContainerStatus>;
  list(botKeys?: readonly string[]): Promise<BotContainerStatus[]>;
  templateDrift(spec: BotContainerSpec): Promise<TemplateDriftReport>;
  create(spec: BotContainerSpec): Promise<void>;
  recreate(spec: BotContainerSpec): Promise<void>;
  writeProfile(botKey: string, profile: CompiledProfile): Promise<void>;
  start(botKey: string): Promise<void>;
  restart(botKey: string): Promise<void>;
  stop(botKey: string): Promise<void>;
  rawRequest(opts: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    caCert?: string;
    clientCert?: string;
    clientKey?: string;
    timeoutMs?: number;
  }): Promise<RawResponse>;
}

export class SiteAgentClientError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly responseBody?: string,
  ) {
    super(`site-agent ${status} ${reason}`);
    this.name = "SiteAgentClientError";
  }
}

export function createSiteAgentTestAdapter(config: SiteAgentTestAdapterConfig): SiteAgentTestAdapter {
  const url = new URL(config.baseUrl);
  const isHttps = url.protocol === "https:";
  const defaultPort = isHttps ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const hostname = url.hostname;

  function doRequest(opts: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    caCert?: string;
    clientCert?: string;
    clientKey?: string;
    timeoutMs?: number;
  }): Promise<RawResponse> {
    const ca = opts.caCert ?? config.caCert;
    const cert = opts.clientCert ?? config.clientCert;
    const key = opts.clientKey ?? config.clientKey;
    const transport = isHttps ? https : http;

    let payload: Buffer | undefined;
    if (opts.body !== undefined) {
      payload = Buffer.isBuffer(opts.body)
        ? opts.body
        : typeof opts.body === "string"
          ? Buffer.from(opts.body, "utf8")
          : Buffer.from(JSON.stringify(opts.body), "utf8");
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(opts.headers ?? {}),
    };

    const reqOptions: https.RequestOptions = {
      host: hostname,
      port,
      path: opts.path.startsWith("/") ? opts.path : `/${opts.path}`,
      method: opts.method,
      headers,
      timeout: opts.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(isHttps
        ? {
            ca,
            cert,
            key,
            rejectUnauthorized: true,
            checkServerIdentity: () => undefined, // test harness connects to 127.0.0.1
          }
        : {}),
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > BODY_LIMIT_BYTES) {
            req.destroy(new Error(`response body exceeded limit of ${BODY_LIMIT_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
          });
        });
      });

      req.on("timeout", () => {
        req.destroy(new Error(`request ${opts.method} ${opts.path} timed out`));
      });
      req.on("error", reject);

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  async function callJson<T>(method: string, subPath: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const fullPath = subPath.startsWith("/v1") ? subPath : `/v1${subPath.startsWith("/") ? subPath : `/${subPath}`}`;
    const res = await doRequest({
      method,
      path: fullPath,
      body,
      timeoutMs,
    });

    if (res.status >= 400) {
      const reason = res.body.slice(0, 200).trim() || "error";
      throw new SiteAgentClientError(res.status, reason, res.body);
    }

    if (!res.body || res.body.trim().length === 0) {
      return {} as T;
    }

    try {
      return JSON.parse(res.body) as T;
    } catch (e) {
      throw new Error(`Failed to parse site-agent response as JSON: ${(e as Error).message}`);
    }
  }

  return {
    endpoint: config.baseUrl,

    async health(): Promise<{ status: string; [key: string]: unknown }> {
      return callJson<{ status: string }>({ method: "GET", path: "/health" }.method, "/health");
    },

    async status(botKey: string): Promise<BotContainerStatus> {
      return callJson<BotContainerStatus>("GET", `/bots/${encodeURIComponent(botKey)}/status`);
    },

    async list(botKeys?: readonly string[]): Promise<BotContainerStatus[]> {
      const res = await callJson<{ bots: BotContainerStatus[] } | BotContainerStatus[]>("GET", "/bots");
      const bots = Array.isArray(res) ? res : res.bots;
      if (!botKeys) return bots;
      const wanted = new Set(botKeys);
      return bots.filter((b) => wanted.has(b.botKey));
    },

    async templateDrift(spec: BotContainerSpec): Promise<TemplateDriftReport> {
      const res = await callJson<{ drift: boolean; fields?: unknown[] }>(
        "POST",
        `/bots/${encodeURIComponent(spec.botKey)}/template-drift`,
        { spec },
      );
      return {
        drifted: res.drift === true,
        fields: (res.fields as any) ?? [],
      };
    },

    async create(spec: BotContainerSpec): Promise<void> {
      await callJson("POST", "/bots", { spec });
    },

    async recreate(spec: BotContainerSpec): Promise<void> {
      await callJson("POST", `/bots/${encodeURIComponent(spec.botKey)}/recreate`, { spec });
    },

    async writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
      await callJson("PUT", `/bots/${encodeURIComponent(botKey)}/profile`, { profile }, START_TIMEOUT_MS);
    },

    async start(botKey: string): Promise<void> {
      await callJson("POST", `/bots/${encodeURIComponent(botKey)}/start`, undefined, START_TIMEOUT_MS);
    },

    async restart(botKey: string): Promise<void> {
      await callJson("POST", `/bots/${encodeURIComponent(botKey)}/restart`, undefined, START_TIMEOUT_MS);
    },

    async stop(botKey: string): Promise<void> {
      await callJson("POST", `/bots/${encodeURIComponent(botKey)}/stop`, undefined, START_TIMEOUT_MS);
    },

    rawRequest(opts) {
      return doRequest(opts);
    },
  };
}
