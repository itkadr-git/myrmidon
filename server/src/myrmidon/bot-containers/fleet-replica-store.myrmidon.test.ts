import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileFleetReplicaStore, fleetReplicaStoreFromEnv, FLEET_REPLICA_DIR_ENV } from "./fleet-replica-store.js";
import { startFleetReplicaLane } from "./fleet-replica-lane.js";
import type { MonitoredSite, SiteBot } from "./site-health-store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "fleet-replica-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const chunks = async (stream: Readable) => {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(Buffer.from(c));
  return Buffer.concat(out).toString();
};

describe("fileFleetReplicaStore", () => {
  it("has no replica before the first write", async () => {
    const store = fileFleetReplicaStore(root);
    expect(await store.capturedAt("myr-vm1", "bot-1")).toBeNull();
    expect(await store.open("myr-vm1", "bot-1")).toBeNull();
  });

  it("stores the stream as latest and opens it back with its age", async () => {
    const store = fileFleetReplicaStore(root);
    const written = await store.write("myr-vm1", "bot-1", Readable.from([Buffer.from("snap-1")]));
    expect(written.bytes).toBe(6);
    const replica = await store.open("myr-vm1", "bot-1");
    expect(await chunks(replica!.stream)).toBe("snap-1");
    expect(Math.abs(replica!.capturedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("keeps the previous replica when a newer one is written", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", Readable.from([Buffer.from("old")]));
    await store.write("s", "b", Readable.from([Buffer.from("new")]));
    const dir = path.join(root, "s", "b");
    expect(await readFile(path.join(dir, "latest.tar.zst"), "utf8")).toBe("new");
    expect(await readFile(path.join(dir, "previous.tar.zst"), "utf8")).toBe("old");
  });

  it("a stream that breaks off never replaces a good replica and leaves no temporary file", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", Readable.from([Buffer.from("good")]));
    const broken = new PassThrough();
    const pending = store.write("s", "b", broken);
    broken.write("par");
    broken.destroy(new Error("link dropped"));
    await expect(pending).rejects.toThrow("link dropped");

    const dir = path.join(root, "s", "b");
    expect(await readFile(path.join(dir, "latest.tar.zst"), "utf8")).toBe("good");
    expect((await readdir(dir)).filter((f) => f.startsWith("incoming-"))).toEqual([]);
  });

  it("an empty stream is not a replica", async () => {
    const store = fileFleetReplicaStore(root);
    await expect(store.write("s", "b", Readable.from([]))).rejects.toThrow("empty");
    expect(await store.capturedAt("s", "b")).toBeNull();
  });

  it("refuses path segments that could leave the store", async () => {
    const store = fileFleetReplicaStore(root);
    await expect(store.capturedAt("../etc", "b")).rejects.toThrow("safe path segment");
    await expect(store.write("s", "a/b", Readable.from([Buffer.from("x")]))).rejects.toThrow("safe path segment");
  });

  it("reports the age of the file as the time the replica was taken", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("s", "b", Readable.from([Buffer.from("x")]));
    const when = new Date("2026-10-23T07:45:00.000Z");
    await utimes(path.join(root, "s", "b", "latest.tar.zst"), when, when);
    expect((await store.capturedAt("s", "b"))?.toISOString()).toBe(when.toISOString());
  });

  it("is off unless the directory variable is set", () => {
    expect(fleetReplicaStoreFromEnv({})).toBeNull();
    expect(fleetReplicaStoreFromEnv({ [FLEET_REPLICA_DIR_ENV]: root })).not.toBeNull();
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
        return Readable.from([Buffer.from(`data-${botKey}`)]);
      },
      write: (siteName, botKey, stream) => store.write(siteName, botKey, stream),
    });
    const result = await lane.tick();
    lane.stop();

    expect(taken).toEqual(["up:up-1", "up:up-2"]);
    expect(result.replicated).toEqual(["up-1", "up-2"]);
    expect(result.skippedSites).toEqual(["missed", "fresh"]);
    expect(await chunks((await store.open("up", "up-2"))!.stream)).toBe("data-up-2");
  });

  it("one bot's failed snapshot keeps its old replica and does not stop the others", async () => {
    const store = fileFleetReplicaStore(root);
    await store.write("up", "a", Readable.from([Buffer.from("old-a")]));
    const lane = startFleetReplicaLane({
      intervalMs: 3_600_000,
      listSites: async () => [site("up", 0)],
      listBots: async (s) => [bot("a", s.name), bot("b", s.name)],
      snapshot: async (_s, botKey) => {
        if (botKey === "a") throw new Error("agent 500");
        return Readable.from([Buffer.from("new-b")]);
      },
      write: (siteName, botKey, stream) => store.write(siteName, botKey, stream),
    });
    const result = await lane.tick();
    lane.stop();

    expect(result.failed).toEqual(["a"]);
    expect(result.replicated).toEqual(["b"]);
    expect(await chunks((await store.open("up", "a"))!.stream)).toBe("old-a");
  });
});
