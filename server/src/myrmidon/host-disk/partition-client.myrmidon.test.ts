// myrmidon(1.6.5-BOT-DISK-H10, rc.9): which dockergate client the host-disk
// sweep gets. On the production host dockergate listens on a unix socket only
// (MYRMIDON_BOT_DOCKER_SOCKET) and MYRMIDON_DOCKERGATE_URL is unset, so the
// partition was never measured and the pressure stayed 0/none.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDockergateDiskClient as createSocketClient,
  dockergateDiskClientFromEnv,
} from "../bot-containers/dockergate-disk-client.js";
import { partitionClientFromEnv, partitionClientFromSocketClient } from "./dockergate.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../docs/myrmidon/bot-disk-contract/dockergate-disk.json", import.meta.url)),
    "utf8",
  ),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("partitionClientFromSocketClient", () => {
  it("maps the C5 answer; usedPercent is a 0..100 percent and is not rescaled", async () => {
    const gate = createSocketClient({
      transport: async () => ({ status: 200, body: JSON.stringify(fixture) }),
    });
    const usage = await partitionClientFromSocketClient(gate).readPartitionUsage();
    expect(usage).toEqual({
      mount: "/srv/myrmidon-xfs",
      usedBytes: fixture.partition.usedBytes,
      totalBytes: fixture.partition.totalBytes,
      freeBytes: fixture.partition.freeBytes,
      usedPercent: 55.1,
      at: fixture.at,
    });
    // the percent agrees with the bytes it was computed from
    expect(usage!.usedPercent).toBeCloseTo((usage!.usedBytes / usage!.totalBytes) * 100, 0);
  });

  it("a dead gate, a deny or contract drift is null, not a throw", async () => {
    const down = createSocketClient({
      transport: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await partitionClientFromSocketClient(down).readPartitionUsage()).toBeNull();
    const denied = createSocketClient({ transport: async () => ({ status: 403, body: '{"error":"route_not_allowed"}' }) });
    expect(await partitionClientFromSocketClient(denied).readPartitionUsage()).toBeNull();
    const drift = createSocketClient({ transport: async () => ({ status: 200, body: '{"partition":{}}' }) });
    expect(await partitionClientFromSocketClient(drift).readPartitionUsage()).toBeNull();
  });
});

describe("partitionClientFromEnv", () => {
  it("neither socket nor URL: no client (previous behaviour)", () => {
    expect(partitionClientFromEnv({})).toBeNull();
    expect(partitionClientFromEnv({ MYRMIDON_BOT_DOCKER_SOCKET: "  ", MYRMIDON_DOCKERGATE_URL: " " })).toBeNull();
  });

  it("only MYRMIDON_BOT_DOCKER_SOCKET (the production env): measures over the unix socket", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dg-sock-"));
    const sock = path.join(dir, "engine.sock");
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(fixture));
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // the raw socket client first: a failure here names its cause
      const raw = await createSocketClient({ socketPath: sock }).getDisk();
      expect(raw.partition.usedPercent).toBe(55.1);
      // the env-built socket client, unwrapped: a failure here names its cause
      const viaEnv = await dockergateDiskClientFromEnv({ MYRMIDON_BOT_DOCKER_SOCKET: sock }).getDisk();
      expect(viaEnv.partition.usedPercent).toBe(55.1);
      const client = partitionClientFromEnv({ MYRMIDON_BOT_DOCKER_SOCKET: sock });
      expect(client).not.toBeNull();
      const usage = await client!.readPartitionUsage();
      expect(usage?.usedPercent).toBe(55.1);
      // three calls above (raw client, env client, selector client), every one a plain GET
      expect(seen).toEqual(Array(3).fill("GET /myrmidon/disk"));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only MYRMIDON_DOCKERGATE_URL: the TCP client", async () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const client = partitionClientFromEnv({ MYRMIDON_DOCKERGATE_URL: "http://dockergate:3399" });
    expect((await client!.readPartitionUsage())?.usedPercent).toBe(55.1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("http://dockergate:3399/myrmidon/disk");
  });

  it("an unreachable socket is null, never a throw", async () => {
    const client = partitionClientFromEnv({ MYRMIDON_BOT_DOCKER_SOCKET: "/nonexistent/engine.sock" });
    expect(await client!.readPartitionUsage()).toBeNull();
  });
});
