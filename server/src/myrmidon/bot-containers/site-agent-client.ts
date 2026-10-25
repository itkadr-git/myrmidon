// server/src/myrmidon/bot-containers/site-agent-client.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): client for site-agent snapshot, restore, and quarantine endpoints.

import http from "node:http";
import https from "node:https";
import { PassThrough, pipeline, type Readable } from "node:stream";
import type { SiteAgentClient } from "./fleet-move-service.js";

export interface SiteAgentClientConfig {
  baseUrl: string;
  token?: string;
  agent?: https.Agent | http.Agent;
  requireMtls?: boolean;
}

/** The site-agent client plus the memory export (C-MEM), which no move uses. */
export interface SiteAgentMemoryClient extends SiteAgentClient {
  /** POST /v1/memory/export: the hindsight transfer archive (zip) of the site's work-memory bank. */
  memoryExport(botKey: string): Promise<Buffer>;
  /** GET /v1/bots/{botKey}/logs: the tail of the bot container's log, already redacted by the site-agent. */
  logs(botKey: string, tail?: number): Promise<string>;
}

/** fleetd caps the export at 64 MiB; a longer answer is not an archive of ours. */
const MAX_MEMORY_EXPORT_BYTES = 80 * 1024 * 1024;
const MEMORY_EXPORT_TIMEOUT_MS = 3 * 60_000;
/** The site-agent returns at most 1 MiB of log; a longer answer is not a log of ours. */
const MAX_BOT_LOGS_BYTES = 2 * 1024 * 1024;
const BOT_LOGS_TIMEOUT_MS = 35_000;

export function createSiteAgentClient(config: SiteAgentClientConfig): SiteAgentMemoryClient {
  const url = new URL(config.baseUrl);
  const isHttps = url.protocol === "https:";
  if (config.requireMtls && (!isHttps || !config.agent)) {
    throw new Error("site-agent mTLS requires an HTTPS URL and a registered client certificate transport");
  }
  const client = isHttps ? https : http;

  function baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }
    return headers;
  }

  function request(options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) {
    return client.request({ ...options, agent: config.agent }, callback);
  }

  return {
    async memoryExport(botKey: string): Promise<Buffer> {
      return new Promise<Buffer>((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({ botKey }));
        const req = request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : isHttps ? 443 : 80,
            path: "/v1/memory/export",
            method: "POST",
            headers: { ...baseHeaders(), "Content-Type": "application/json", "Content-Length": String(body.length), Accept: "application/zip" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_MEMORY_EXPORT_BYTES) {
                req.destroy(new Error("Site-agent memory export is larger than the allowed size"));
                return;
              }
              chunks.push(chunk);
            });
            // A response that broke off must fail, never pass for a short archive.
            res.on("error", reject);
            res.on("aborted", () => reject(new Error(`Site-agent memory export ${botKey} broke off`)));
            res.on("end", () => {
              const data = Buffer.concat(chunks);
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Site-agent memory export ${botKey} failed with ${res.statusCode}: ${data.toString("utf8").slice(0, 300)}`));
                return;
              }
              resolve(data);
            });
          },
        );
        req.setTimeout(MEMORY_EXPORT_TIMEOUT_MS, () => req.destroy(new Error("Site-agent memory export timed out")));
        req.on("error", reject);
        req.end(body);
      });
    },

    async snapshot(botKey: string): Promise<Readable> {
      return new Promise<Readable>((resolve, reject) => {
        const path = `/v1/bots/${encodeURIComponent(botKey)}/snapshot`;
        const req = request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : isHttps ? 443 : 80,
            path,
            method: "POST",
            headers: {
              ...baseHeaders(),
              Accept: "application/x-tar+zstd, application/octet-stream",
            },
          },
          (res) => {
            if (res.statusCode && res.statusCode >= 400) {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                const msg = Buffer.concat(chunks).toString("utf8");
                reject(new Error(`Site-agent snapshot ${botKey} failed with ${res.statusCode}: ${msg}`));
              });
              return;
            }
            // pipeline, not pipe: a response that breaks off (the site-agent aborts a snapshot
            // it could not finish) destroys `pass` with an error, so the consumer sees a failed
            // stream and never a short one that looks complete.
            const pass = new PassThrough();
            pass.on("error", () => {}); // the consumer attaches its own handler; this only keeps the gap before it from being fatal
            pipeline(res, pass, () => {});
            resolve(pass);
          },
        );

        req.on("error", reject);
        req.end();
      });
    },

    async restore(botKey: string, stream: Readable): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const path = `/v1/bots/${encodeURIComponent(botKey)}/restore`;
        const req = request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : isHttps ? 443 : 80,
            path,
            method: "POST",
            headers: {
              ...baseHeaders(),
              "Content-Type": "application/x-tar+zstd",
            },
          },
          (res) => {
            if (res.statusCode && res.statusCode >= 400) {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                const msg = Buffer.concat(chunks).toString("utf8");
                reject(new Error(`Site-agent restore ${botKey} failed with ${res.statusCode}: ${msg}`));
              });
              return;
            }
            res.on("data", () => {});
            res.on("end", () => resolve());
          },
        );

        req.on("error", reject);
        // A source that fails mid-way destroys the request: the destination sees a body that
        // broke off, refuses it, and nothing is put in place.
        pipeline(stream, req, (err) => {
          if (err) reject(err);
        });
      });
    },

    async quarantine(botKey: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const path = `/v1/bots/${encodeURIComponent(botKey)}/quarantine`;
        const req = request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : isHttps ? 443 : 80,
            path,
            method: "POST",
            headers: baseHeaders(),
          },
          (res) => {
            if (res.statusCode && res.statusCode >= 400) {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                const msg = Buffer.concat(chunks).toString("utf8");
                reject(new Error(`Site-agent quarantine ${botKey} failed with ${res.statusCode}: ${msg}`));
              });
              return;
            }
            res.on("data", () => {});
            res.on("end", () => resolve());
          },
        );

        req.on("error", reject);
        req.end();
      });
    },

    async logs(botKey: string, tail = 100): Promise<string> {
      if (!Number.isInteger(tail) || tail < 1 || tail > 1000) throw new Error("Site-agent logs tail must be between 1 and 1000");
      return new Promise<string>((resolve, reject) => {
        const req = request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : isHttps ? 443 : 80,
            path: `/v1/bots/${encodeURIComponent(botKey)}/logs?tail=${tail}`,
            method: "GET",
            headers: { ...baseHeaders(), Accept: "text/plain" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_BOT_LOGS_BYTES) {
                req.destroy(new Error("Site-agent bot log is larger than the allowed size"));
                return;
              }
              chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("aborted", () => reject(new Error(`Site-agent logs ${botKey} broke off`)));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Site-agent logs ${botKey} failed with ${res.statusCode}: ${text.slice(0, 300)}`));
                return;
              }
              try {
                const parsed = JSON.parse(text) as { logs?: unknown };
                resolve(typeof parsed.logs === "string" ? parsed.logs : "");
              } catch {
                reject(new Error(`Site-agent logs ${botKey}: the answer is not the logs contract`));
              }
            });
          },
        );
        req.setTimeout(BOT_LOGS_TIMEOUT_MS, () => req.destroy(new Error("Site-agent logs timed out")));
        req.on("error", reject);
        req.end();
      });
    },


  };
}
