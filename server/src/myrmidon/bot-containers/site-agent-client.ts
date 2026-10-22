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
}

export function createSiteAgentClient(config: SiteAgentClientConfig): SiteAgentClient {
  const url = new URL(config.baseUrl);
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;

  function baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }
    return headers;
  }

  return {
    async snapshot(botKey: string): Promise<Readable> {
      return new Promise<Readable>((resolve, reject) => {
        const path = `/v1/bots/${encodeURIComponent(botKey)}/snapshot`;
        const req = client.request(
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
            agent: config.agent,
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
        const req = client.request(
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
            agent: config.agent,
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
        const req = client.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : isHttps ? 443 : 80,
            path,
            method: "POST",
            headers: baseHeaders(),
            agent: config.agent,
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
  };
}
