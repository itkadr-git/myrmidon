// myrmidon(1.6.5-BOT-DISK-H9c): the dockergate disk client against a fake gate on
// a real unix socket, answering with the C5 fixtures of docs/myrmidon/bot-disk-contract.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WS_QUOTA_MIN_BYTES,
  wsDiskApiResponseSchema,
  wsDiskQuotaPutRequestSchema,
  wsDiskQuotaPutResponseSchema,
} from "@paperclipai/shared";
import {
  createDockergateDiskClient,
  DockergateDiskError,
  dockergateDiskClientFromEnv,
} from "./dockergate-disk-client.js";

const FIXTURES = path.resolve(__dirname, "../../../../docs/myrmidon/bot-disk-contract");
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

describe("myrmidon(BOT-DISK-H9c) C5 fixtures pass the schemas", () => {
  it("disk, put request and put response", () => {
    expect(wsDiskApiResponseSchema.safeParse(fixture("dockergate-disk.json")).success).toBe(true);
    expect(wsDiskQuotaPutRequestSchema.safeParse(fixture("dockergate-quota-put-request.json")).success).toBe(true);
    expect(wsDiskQuotaPutResponseSchema.safeParse(fixture("dockergate-quota-put-response.json")).success).toBe(true);
  });
});

describe("myrmidon(BOT-DISK-H9c) dockergate disk client over a unix socket", () => {
  let dir = "";
  let socketPath = "";
  let server: http.Server;
  const seen: { method: string; url: string; body: string }[] = [];
  let mode: "ok" | "deny" | "garbage" = "ok";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-disk-"));
    socketPath = path.join(dir, "gate.sock");
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        res.setHeader("Content-Type", "application/json");
        if (mode === "deny") {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "quota_unavailable" }));
        } else if (mode === "garbage") {
          res.end(JSON.stringify({ partition: 1 }));
        } else if (req.method === "GET" && req.url === "/myrmidon/disk") {
          res.end(JSON.stringify(fixture("dockergate-disk.json")));
        } else if (req.method === "PUT" && /^\/myrmidon\/disk\/[^/]+\/quota$/.test(req.url ?? "")) {
          res.end(JSON.stringify(fixture("dockergate-quota-put-response.json")));
        } else {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "route_not_allowed" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET parses the C5 answer and caches it briefly", async () => {
    mode = "ok";
    seen.length = 0;
    let t = 0;
    const client = createDockergateDiskClient({ socketPath, now: () => t });
    const first = await client.getDisk();
    expect(first.projects[0]?.botKey).toBe("bot-001");
    await client.getDisk();
    expect(seen.filter((r) => r.method === "GET")).toHaveLength(1);
    t = 60_000;
    await client.getDisk();
    expect(seen.filter((r) => r.method === "GET")).toHaveLength(2);
  });

  it("PUT sends {bytes} to the bot's quota path and parses the answer", async () => {
    mode = "ok";
    seen.length = 0;
    const client = createDockergateDiskClient({ socketPath });
    const answer = await client.putQuota("bot-001", 6442450944);
    expect(answer).toEqual({ ok: true, projectId: 1041, hardBytes: 6442450944 });
    expect(seen).toEqual([{ method: "PUT", url: "/myrmidon/disk/bot-001/quota", body: '{"bytes":6442450944}' }]);
  });

  it("PUT below the contract minimum is refused before any request", async () => {
    seen.length = 0;
    const client = createDockergateDiskClient({ socketPath });
    await expect(client.putQuota("bot-001", WS_QUOTA_MIN_BYTES - 1)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("a deny answer surfaces its code", async () => {
    mode = "deny";
    const client = createDockergateDiskClient({ socketPath });
    const error = await client.getDisk().catch((caught) => caught);
    expect(error).toBeInstanceOf(DockergateDiskError);
    expect(error).toMatchObject({ status: 403, denyCode: "quota_unavailable" });
  });

  it("an off-contract body is an error, not numbers", async () => {
    mode = "garbage";
    const client = createDockergateDiskClient({ socketPath });
    await expect(client.getDisk()).rejects.toBeInstanceOf(DockergateDiskError);
  });

  it("an unreachable gate is an error with status 0", async () => {
    const client = dockergateDiskClientFromEnv({ MYRMIDON_BOT_DOCKER_SOCKET: path.join(dir, "absent.sock") });
    await expect(client.getDisk()).rejects.toMatchObject({ status: 0 });
  });
});
