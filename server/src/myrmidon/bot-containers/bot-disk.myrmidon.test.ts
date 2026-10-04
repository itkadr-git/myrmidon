// myrmidon(1.6.1-BOT-DISK-B): the shared package cache binds, the variables that
// point the tools at them, the stored settings and the fleetd no-op.
// Everything here is placeholder data: fake paths, keys and values.

import { describe, expect, it, vi } from "vitest";

import { parseBotDiskSettings, preserveBotDiskGeneralKey } from "./bot-disk-store.js";
import { patchBotDiskSettingsSchema } from "./bot-disk-api.js";
import { FLEETD_PACKAGE_CACHE_NOTICE, fleetdBotContainerDriver } from "./fleetd-driver.js";
import type { BotContainerSpec } from "./driver.js";
import {
  buildBinds,
  packageCacheEnv,
  PACKAGE_CACHE_MOUNTS,
  sharedPackageCachePathProblem,
} from "./template.js";

const volumeRoot = "/srv/bots";
const botKey = "agent-a";
const cache = "/srv/package-cache";

describe("myrmidon(1.6.1-BOT-DISK-B) buildBinds with the shared package cache", () => {
  it("writes only the three fixed binds when no cache is configured", () => {
    expect(buildBinds(volumeRoot, botKey)).toEqual([
      `${volumeRoot}/${botKey}/hermes:/data/hermes`,
      `${volumeRoot}/${botKey}/workspace:/workspace`,
      `${volumeRoot}/${botKey}/scratch:/scratch`,
    ]);
  });

  it("appends one writable bind per cache, under /cache, after the card mounts", () => {
    const binds = buildBinds(volumeRoot, botKey, {
      mounts: [{ source: "/srv/docs", containerPath: "/docs", readOnly: true }],
      allowedSources: ["/srv/docs"],
      sharedPackageCachePath: cache,
    });
    expect(binds.slice(3)).toEqual([
      "/srv/docs:/docs:ro",
      `${cache}/pnpm:/cache/pnpm:rw`,
      `${cache}/go-mod:/cache/go-mod:rw`,
      `${cache}/go-build:/cache/go-build:rw`,
      `${cache}/gradle:/cache/gradle:rw`,
    ]);
  });

  it("refuses a card mount on the cache's container paths while a cache is configured", () => {
    const mounts = [{ source: "/srv/docs", containerPath: "/cache/pnpm", readOnly: true as const }];
    expect(() =>
      buildBinds(volumeRoot, botKey, { mounts, allowedSources: ["/srv/docs"], sharedPackageCachePath: cache }),
    ).toThrow(/reserved for the shared package cache/);
    // Without a cache the path is an ordinary mount point.
    expect(buildBinds(volumeRoot, botKey, { mounts, allowedSources: ["/srv/docs"] })[3]).toBe(
      "/srv/docs:/cache/pnpm:ro",
    );
  });

  it("rejects a cache path that is not a plain absolute directory", () => {
    for (const bad of ["relative/cache", "/srv/../etc", "/", "/srv/cache/"]) {
      expect(() => buildBinds(volumeRoot, botKey, { sharedPackageCachePath: bad })).toThrow(/shared package cache path/);
      expect(sharedPackageCachePathProblem(bad)).not.toBeNull();
    }
    expect(sharedPackageCachePathProblem(cache)).toBeNull();
  });

  it("points every tool at its mount, and leaves pip out", () => {
    expect(packageCacheEnv()).toEqual({
      npm_config_store_dir: "/cache/pnpm",
      GOMODCACHE: "/cache/go-mod",
      GOCACHE: "/cache/go-build",
      GRADLE_USER_HOME: "/cache/gradle",
    });
    expect(PACKAGE_CACHE_MOUNTS.map((mount) => mount.hostSubdir)).not.toContain("pip");
  });
});

describe("myrmidon(1.6.1-BOT-DISK-B) stored bot disk settings", () => {
  it("parses the cache path and ignores a blank one", () => {
    expect(parseBotDiskSettings({ botDisk: { sharedPackageCachePath: "/mnt/c" } })).toEqual({
      sharedPackageCachePath: "/mnt/c",
    });
    expect(parseBotDiskSettings({ botDisk: { sharedPackageCachePath: "  " } })).toEqual({});
    expect(parseBotDiskSettings({ botDisk: { sharedPackageCachePath: 7 } })).toEqual({});
    expect(parseBotDiskSettings(null)).toEqual({});
  });

  it("carries only the botDisk key over a vendor write", () => {
    expect(preserveBotDiskGeneralKey({ botDisk: { sharedPackageCachePath: "/mnt/c" }, other: 1 })).toEqual({
      botDisk: { sharedPackageCachePath: "/mnt/c" },
    });
    expect(preserveBotDiskGeneralKey({ other: 1 })).toEqual({});
    expect(preserveBotDiskGeneralKey(undefined)).toEqual({});
  });

  it("accepts a path or null in a PATCH and nothing else", () => {
    expect(patchBotDiskSettingsSchema.safeParse({ sharedPackageCachePath: cache }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({ sharedPackageCachePath: null }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({}).success).toBe(false);
    expect(patchBotDiskSettingsSchema.safeParse({ sharedPackageCachePath: cache, extra: true }).success).toBe(false);
  });
});

describe("myrmidon(1.6.1-BOT-DISK-B) fleetd driver and the shared package cache", () => {
  const spec: BotContainerSpec = {
    botKey: "bot-a",
    image: "registry.example/bot@sha256:" + "0".repeat(64),
    memoryMb: 512,
    cpus: 1,
    pidsLimit: 256,
    network: "bots",
  };

  function driverWith(path: string | undefined) {
    const warn = vi.fn();
    const request = vi.fn(async () => ({ status: 204, body: Buffer.alloc(0) }));
    const driver = fleetdBotContainerDriver(
      { baseUrl: "http://fleet.example.com:8080", token: "fake-token" },
      { request, readSharedPackageCachePath: async () => path, log: { warn } },
    );
    return { driver, warn, request };
  }

  it("sends the spec unchanged and logs the no-op once when a cache is configured", async () => {
    const { driver, warn, request } = driverWith(cache);
    await driver.create(spec);
    await driver.recreate(spec);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe(FLEETD_PACKAGE_CACHE_NOTICE);
    const bodies = request.mock.calls.map((call) => JSON.parse((call as unknown as [{ body: Buffer }])[0].body.toString("utf8")));
    expect(bodies).toEqual([{ spec }, { spec }]);
  });

  it("stays silent without a cache", async () => {
    const { driver, warn } = driverWith(undefined);
    await driver.create(spec);
    expect(warn).not.toHaveBeenCalled();
  });
});
