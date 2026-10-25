// server/src/myrmidon/bot-containers/site-agent-client.myrmidon.test.ts
//
// myrmidon(1.6.6 C-MEM): the memory export call of the site-agent client against a local server.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSiteAgentClient } from "./site-agent-client.js";

describe("site-agent client memoryExport", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("posts the bot key with the bearer token and returns the archive bytes", async () => {
    let seen: { method?: string; url?: string; auth?: string; body?: string } = {};
    const baseUrl = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      });
    });

    const archive = await createSiteAgentClient({ baseUrl, token: "tok" }).memoryExport("work-qa");

    expect(archive).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(seen).toEqual({ method: "POST", url: "/v1/memory/export", auth: "Bearer tok", body: '{"botKey":"work-qa"}' });
  });

  it("rejects with the site-agent's answer when it refuses", async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(503);
      res.end("centralized_memory_disabled");
    });

    await expect(createSiteAgentClient({ baseUrl }).memoryExport("work-qa")).rejects.toThrow(
      "Site-agent memory export work-qa failed with 503: centralized_memory_disabled",
    );
  });

  it("rejects when nothing listens", async () => {
    const baseUrl = await serve((_req, res) => res.end());
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    await expect(createSiteAgentClient({ baseUrl }).memoryExport("work-qa")).rejects.toThrow();
  });

  it("reads the bot log with the bearer token", async () => {
    let seen: { method?: string; url?: string; auth?: string } = {};
    const baseUrl = await serve((req, res) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs: "line 1\nline 2\n" }));
    });
    const logs = await createSiteAgentClient({ baseUrl, token: "tok" }).logs("work-qa", 2);
    expect(logs).toBe("line 1\nline 2\n");
    expect(seen).toEqual({ method: "GET", url: "/v1/bots/work-qa/logs?tail=2", auth: "Bearer tok" });
  });

  it("rejects a log answer that is an error or not the logs contract", async () => {
    const refused = await serve((_req, res) => {
      res.writeHead(403);
      res.end("bot_not_enrolled");
    });
    await expect(createSiteAgentClient({ baseUrl: refused }).botLogs("work-qa")).rejects.toThrow(
      "Site-agent logs work-qa failed with 403: bot_not_enrolled",
    );
    const odd = await serve((_req, res) => res.end("<html>"));
    await expect(createSiteAgentClient({ baseUrl: odd }).botLogs("work-qa")).rejects.toThrow("not the logs contract");
  });

  it("fetches bounded logs from the authenticated site-agent endpoint", async () => {
    let seen = "";
    const baseUrl = await serve((req, res) => {
      seen = `${req.method} ${req.url} ${req.headers.authorization}`;
      res.end("line one\nline two\n");
    });
    const client = createSiteAgentClient({ baseUrl, token: "tok" });
    await expect(client.logs("work-qa", 25)).resolves.toBe("line one\nline two\n");
    expect(seen).toBe("GET /v1/bots/work-qa/logs?tail=25 Bearer tok");
    await expect(client.logs("work-qa", 0)).rejects.toThrow("tail must be between 1 and 1000");
  });
});
