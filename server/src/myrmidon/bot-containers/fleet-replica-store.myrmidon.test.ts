import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileFleetReplicaStore, fleetReplicaStoreFromEnv, FLEET_REPLICA_DIR_ENV } from "./fleet-replica-store.js";
import { startFleetReplicaLane } from "./fleet-replica-lane.js";
import { makeSnapshot, readSnapshot, type SnapshotEntry } from "./fleet-replica-snapshot-fixtures.js";
import type { MonitoredSite, SiteBot } from "./site-health-store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "fleet-replica-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const collect = async (stream: Readable): Promise<Buffer> => {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(Buffer.from(c));
  return Buffer.concat(out);
};

/** A snapshot of a bot's datadir as the site-agent streams it; the content tells replicas apart. */
const snapshotOf = (content: string, extra: SnapshotEntry[] = []): Buffer =>
  makeSnapshot([{ path: "workspace", type: "directory" }, { path: "workspace/data.txt", content }, ...extra]);

const stream = (buffer: Buffer): Readable => Readable.from([buffer]);

const contentOf = (snapshot: Buffer): string | undefined => readSnapshot(snapshot).entries.find((e) => e.name === "workspace/data.txt")?.content;

describe("fileFleetReplicaStore", () => {
  it("has no replica before the first write", async () => {
    const store = fileFleetReplicaStore(root);
    expect(await store.capturedAt("site-a", "bot-1")).toBeNull();
    expect(await store.open("site-a", "bot-1")).toBeNull();
  });

  it("stores the snapshot as latest and opens it back with its age", async () => {
    const store = fileFleetReplicaStore(root);
    const input = snapshotOf("snap-1");
    const written = await store.write("site-a", "bot-1", stream(input));
    expect(written.bytes).toBeGreaterThan(0);
    expect(written.excludedPaths).toEqual([]);
    const replica = await store.open("site-a", "bot-1");
    const stored = await collect(replica!.stream);
    expect(stored.length).toBe(written.bytes);
    expect(contentOf(stored)).toBe("snap-1");
    expect(readSnapshot(stored).manifestOk).toBe(true);
    expect(Math.abs(replica!.capturedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("keeps the previous replica when a newer one is written", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", stream(snapshotOf("old")));
    await store.write("s", "b", stream(snapshotOf("new")));
    const dir = path.join(root, "s", "b");
    expect(contentOf(await readFile(path.join(dir, "latest.tar.zst")))).toBe("new");
    expect(contentOf(await readFile(path.join(dir, "previous.tar.zst")))).toBe("old");
  });

  it("a stream that breaks off never replaces a good replica and leaves no temporary file", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", stream(snapshotOf("good")));
    // The link drops some time after the transfer started, not before the store is listening.
    const prefix = snapshotOf("x".repeat(5000)).subarray(0, 300);
    let sent = false;
    const broken = new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(prefix);
        setTimeout(() => this.destroy(new Error("link dropped")), 20);
      },
    });
    await expect(store.write("s", "b", broken)).rejects.toThrow("link dropped");

    const dir = path.join(root, "s", "b");
    expect(contentOf(await readFile(path.join(dir, "latest.tar.zst")))).toBe("good");
    expect((await readdir(dir)).filter((f) => f.startsWith("incoming-"))).toEqual([]);
  });

  it("a snapshot cut off half way, or with a wrong manifest, never replaces a good replica", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", stream(snapshotOf("good")));
    const whole = snapshotOf("x".repeat(5000));
    await expect(store.write("s", "b", stream(whole.subarray(0, Math.floor(whole.length / 2))))).rejects.toThrow(/ended inside/);
    const wrong = makeSnapshot([{ path: "workspace/data.txt", content: "bad" }], { manifest: "wrong" });
    await expect(store.write("s", "b", stream(wrong))).rejects.toThrow(/verification failed/);

    const dir = path.join(root, "s", "b");
    expect(contentOf(await readFile(path.join(dir, "latest.tar.zst")))).toBe("good");
    expect((await readdir(dir)).sort()).toEqual(["latest.tar.zst"]);
  });

  it("something that is not a snapshot is not a replica", async () => {
    const store = fileFleetReplicaStore(root);
    await expect(store.write("s", "b", Readable.from([Buffer.from("plain bytes")]))).rejects.toThrow(/not a zstd frame/);
    expect(await store.capturedAt("s", "b")).toBeNull();
    expect((await readdir(path.join(root, "s", "b"))).filter((f) => f.startsWith("incoming-"))).toEqual([]);
  });

  it("an empty stream is not a replica", async () => {
    const store = fileFleetReplicaStore(root);
    await expect(store.write("s", "b", Readable.from([]))).rejects.toThrow("empty");
    expect(await store.capturedAt("s", "b")).toBeNull();
  });

  it("refuses path segments that could leave the store", async () => {
    const store = fileFleetReplicaStore(root);
    await expect(store.capturedAt("../etc", "b")).rejects.toThrow("safe path segment");
    await expect(store.write("s", "a/b", stream(snapshotOf("x")))).rejects.toThrow("safe path segment");
  });

  it("reports the age of the file as the time the replica was taken", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", stream(snapshotOf("x")));
    const when = new Date("2026-10-23T07:45:00.000Z");
    await utimes(path.join(root, "s", "b", "latest.tar.zst"), when, when);
    expect((await store.capturedAt("s", "b"))?.toISOString()).toBe(when.toISOString());
  });

  it("is off unless the directory variable is set", () => {
    expect(fleetReplicaStoreFromEnv({})).toBeNull();
    expect(fleetReplicaStoreFromEnv({ [FLEET_REPLICA_DIR_ENV]: root })).not.toBeNull();
  });
});

describe("fileFleetReplicaStore: the secret profile files are not stored", () => {
  const SECRET_ENV = "API_SERVER_KEY=fake-secret-key-0001\nPAPERCLIP_API_KEY=fake-board-key-0002\n";
  const SECRET_CONFIG = "mcp_servers:\n  board:\n    headers:\n      Authorization: Bearer fake-header-token\n";
  const withSecrets = (content: string): Buffer =>
    snapshotOf(content, [
      { path: "hermes", type: "directory" },
      { path: "hermes/.env", content: SECRET_ENV },
      { path: "hermes/config.yaml", content: SECRET_CONFIG },
      { path: "hermes/state.db", content: "database" },
    ]);

  it("writes a replica without hermes/.env and hermes/config.yaml, with a manifest that matches, and says what it left out", async () => {
    const store = fileFleetReplicaStore(root);
    const written = await store.write("site-a", "bot-1", stream(withSecrets("data")));
    expect(written.excludedPaths).toEqual(["hermes/.env", "hermes/config.yaml"]);

    const onDisk = await readFile(path.join(root, "site-a", "bot-1", "latest.tar.zst"));
    expect(onDisk.length).toBe(written.bytes);
    expect(onDisk.includes(Buffer.from("fake-secret-key-0001"))).toBe(false);
    expect(onDisk.includes(Buffer.from("fake-board-key-0002"))).toBe(false);
    expect(onDisk.includes(Buffer.from("fake-header-token"))).toBe(false);
    const snapshot = readSnapshot(onDisk);
    expect(snapshot.manifestOk).toBe(true);
    expect(snapshot.entries.map((e) => e.name)).toEqual(["workspace", "workspace/data.txt", "hermes", "hermes/state.db"]);
    // and a restore reads the same thing back from open()
    expect(readSnapshot(await collect((await store.open("site-a", "bot-1"))!.stream))).toEqual(snapshot);
  });

  it("the previous replica rotates in as it is, and the next write is filtered again", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", stream(withSecrets("one")));
    await store.write("s", "b", stream(withSecrets("two")));
    for (const file of ["latest.tar.zst", "previous.tar.zst"]) {
      const onDisk = await readFile(path.join(root, "s", "b", file));
      expect(onDisk.includes(Buffer.from("fake-secret-key-0001"))).toBe(false);
      expect(readSnapshot(onDisk).manifestOk).toBe(true);
    }
  });

  it("takes the paths from the options", async () => {
    const store = fileFleetReplicaStore(root, { excludePaths: ["workspace/data.txt"] });
    const written = await store.write("s", "b", stream(withSecrets("data")));
    expect(written.excludedPaths).toEqual(["workspace/data.txt"]);
    const names = readSnapshot(await readFile(path.join(root, "s", "b", "latest.tar.zst"))).entries.map((e) => e.name);
    expect(names).toContain("hermes/.env");
    expect(names).not.toContain("workspace/data.txt");
  });
});

describe("replica lane", () => {
  const site = (name: string, missCount: number | null): MonitoredSite => ({
    id: name, companyId: "c", name, url: "https://x", status: "active", labels: {},
    health: missCount === null ? null : { snapshot: { missCount }, autoDrained: false, state: "healthy", recoveryPasses: 0, reconciled: false, updatedAt: "" },
  });
  const bot = (botKey: string, s: string): SiteBot => ({ companyId: "c", botKey, site: s, pinned: false });

  it("replicates each bot of an answering site, one at a time, and skips sites that missed or were never probed", async () => {
    const store = fileFleetReplicaStore(root);
    const taken: string[] = [];
    const lane = startFleetReplicaLane({
      intervalMs: 3_600_000,
      listSites: async () => [site("up", 0), site("missed", 2), site("fresh", null)],
      listBots: async (s) => [bot(`${s.name}-1`, s.name), bot(`${s.name}-2`, s.name)],
      snapshot: async (s, botKey) => {
        taken.push(`${s.name}:${botKey}`);
        return stream(snapshotOf(`data-${botKey}`));
      },
      write: (siteName, botKey, stream) => store.write(siteName, botKey, stream),
    });
    const result = await lane.tick();
    lane.stop();

    expect(taken).toEqual(["up:up-1", "up:up-2"]);
    expect(result.replicated).toEqual(["up-1", "up-2"]);
    expect(result.skippedSites).toEqual(["missed", "fresh"]);
    expect(contentOf(await collect((await store.open("up", "up-2"))!.stream))).toBe("data-up-2");
  });

  it("one bot's failed snapshot keeps its old replica and does not stop the others", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("up", "a", stream(snapshotOf("old-a")));
    const lane = startFleetReplicaLane({
      intervalMs: 3_600_000,
      listSites: async () => [site("up", 0)],
      listBots: async (s) => [bot("a", s.name), bot("b", s.name)],
      snapshot: async (_s, botKey) => {
        if (botKey === "a") throw new Error("agent 500");
        return stream(snapshotOf("new-b"));
      },
      write: (siteName, botKey, stream) => store.write(siteName, botKey, stream),
    });
    const result = await lane.tick();
    lane.stop();

    expect(result.failed).toEqual(["a"]);
    expect(result.replicated).toEqual(["b"]);
    expect(contentOf(await collect((await store.open("up", "a"))!.stream))).toBe("old-a");
  });

  it("a snapshot the filter refuses counts as failed and keeps the old replica", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("up", "a", stream(snapshotOf("old-a")));
    const lane = startFleetReplicaLane({
      intervalMs: 3_600_000,
      listSites: async () => [site("up", 0)],
      listBots: async (s) => [bot("a", s.name)],
      snapshot: async () => stream(makeSnapshot([{ path: "workspace/data.txt", content: "bad" }], { manifest: "none" })),
      write: (siteName, botKey, stream) => store.write(siteName, botKey, stream),
    });
    const result = await lane.tick();
    lane.stop();

    expect(result.failed).toEqual(["a"]);
    expect(result.replicated).toEqual([]);
    expect(contentOf(await collect((await store.open("up", "a"))!.stream))).toBe("old-a");
  });
});
