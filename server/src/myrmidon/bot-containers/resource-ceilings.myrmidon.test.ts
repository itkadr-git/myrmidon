// server/src/myrmidon/bot-containers/resource-ceilings.myrmidon.test.ts
//
// myrmidon(OPE-12337): unit tests for readBotResourceCeilings against a fake
// unix-socket server (route A21 limits endpoint) and botResourceCeilingProblem.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOT_DOCKER_SOCKET_ENV_NAME } from "./dockergate-disk-client.js";
import {
  botResourceCeilingProblem,
  readBotResourceCeilings,
  setBotResourceCeilingsReaderForTest,
  type BotResourceCeilings,
} from "./resource-ceilings.js";

describe("myrmidon(OPE-12337) readBotResourceCeilings over fake unix socket", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: http.Server;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    // Ensure any leftover test hook is cleared
    setBotResourceCeilingsReaderForTest(null);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-gate-ceilings-"));
    socketPath = path.join(tmpDir, "dockergate.sock");

    server = http.createServer((req, res) => {
      handler(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => resolve());
      server.on("error", reject);
    });
  });

  afterAll(async () => {
    setBotResourceCeilingsReaderForTest(null);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const testEnv = () => ({
    [BOT_DOCKER_SOCKET_ENV_NAME]: socketPath,
  });

  it("parses 200 response with effective limits", async () => {
    handler = (req, res) => {
      expect(req.url).toBe("/myrmidon/bots/bot-eng-1/limits");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          botKey: "bot-eng-1",
          memoryMb: 2048,
          cpus: 4,
          pidsLimit: 2048,
          ceilingMemoryMb: 1024,
          ceilingCpus: 2,
          ceilingPids: 500,
          effectiveMemoryMb: 1024,
          effectiveCpus: 2,
          effectivePidsLimit: 500,
        }),
      );
    };

    const ceilings = await readBotResourceCeilings("bot-eng-1", testEnv());
    expect(ceilings).toEqual({
      memoryMb: 1024,
      cpus: 2,
      pidsLimit: 500,
    });
  });

  it("falls back to memoryMb/cpus/pidsLimit when effective* are absent in 200 response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          botKey: "bot-eng-2",
          memoryMb: 3072,
          cpus: 3,
          pidsLimit: 1024,
        }),
      );
    };

    const ceilings = await readBotResourceCeilings("bot-eng-2", testEnv());
    expect(ceilings).toEqual({
      memoryMb: 3072,
      cpus: 3,
      pidsLimit: 1024,
    });
  });

  it("returns null on 404 (bot not enrolled)", async () => {
    handler = (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bot_not_enrolled" }));
    };

    const ceilings = await readBotResourceCeilings("unknown-bot", testEnv());
    expect(ceilings).toBeNull();
  });

  it("returns null on 403 (forbidden caller or access)", async () => {
    handler = (_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
    };

    const ceilings = await readBotResourceCeilings("bot-eng-1", testEnv());
    expect(ceilings).toBeNull();
  });

  it("returns null on invalid / bad JSON response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("NOT-JSON-{{{;");
    };

    const ceilings = await readBotResourceCeilings("bot-eng-1", testEnv());
    expect(ceilings).toBeNull();
  });

  it("returns null on invalid non-positive or non-number limits", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          effectiveMemoryMb: -100,
          effectiveCpus: 0,
          effectivePidsLimit: "many",
        }),
      );
    };

    const ceilings = await readBotResourceCeilings("bot-eng-1", testEnv());
    expect(ceilings).toBeNull();
  });

  it("returns null on connection error / non-existent socket", async () => {
    const ceilings = await readBotResourceCeilings("bot-eng-1", {
      [BOT_DOCKER_SOCKET_ENV_NAME]: path.join(tmpDir, "non-existent.sock"),
    });
    expect(ceilings).toBeNull();
  });

  it("returns null on socket timeout / hung request", async () => {
    handler = (_req, _res) => {
      // Intentionally do not reply to trigger timeout/socket abort
    };

    // Use a fast timeout simulation: readBotResourceCeilings has 3s timeout
    // We can verify timeout returns null
    const promise = readBotResourceCeilings("bot-eng-1", testEnv());
    // Destroy connection from server side to simulate abort/timeout
    server.closeAllConnections();
    const result = await promise;
    expect(result).toBeNull();
  });
});

describe("myrmidon(OPE-12337) botResourceCeilingProblem validation", () => {
  const ceilings: BotResourceCeilings = {
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 500,
  };

  it("returns null when container limits are within ceilings", () => {
    expect(botResourceCeilingProblem({ memoryMb: 2048, cpus: 2, pidsLimit: 500 }, ceilings)).toBeNull();
    expect(botResourceCeilingProblem({ memoryMb: 1024, cpus: 1, pidsLimit: 250 }, ceilings)).toBeNull();
  });

  it("detects memoryMb exceeding ceiling", () => {
    const problem = botResourceCeilingProblem({ memoryMb: 3072 }, ceilings);
    expect(problem).toContain("memoryMb 3072 exceeds dockergate ceiling 2048 МБ");
    expect(problem).toContain("bots[].maxMemoryMb");
  });

  it("detects cpus exceeding ceiling", () => {
    const problem = botResourceCeilingProblem({ cpus: 4 }, ceilings);
    expect(problem).toContain("cpus 4 exceeds dockergate ceiling 2 CPU");
    expect(problem).toContain("bots[].maxCpus");
  });

  it("detects pidsLimit exceeding ceiling", () => {
    const problem = botResourceCeilingProblem({ pidsLimit: 1000 }, ceilings);
    expect(problem).toContain("pidsLimit 1000 exceeds dockergate ceiling 500 PIDs");
    expect(problem).toContain("bots[].maxPids");
  });
});
