// myrmidon(1.6.1-BOT-DISK-B): the shared package cache binds and the stored settings.

import { describe, expect, it } from "vitest";

import { parseBotDiskSettings, preserveBotDiskGeneralKey } from "./bot-disk-store.js";
import { buildBinds, PACKAGE_CACHE_MOUNTS } from "./template.js";

const volumeRoot = "/srv/bots";
const botKey = "agent-a";

describe("myrmidon(1.6.1-BOT-DISK-B) buildBinds with the shared package cache", () => {
  it("writes only the three fixed binds when no cache is configured", () => {
    expect(buildBinds(volumeRoot, botKey)).toEqual([
      `${volumeRoot}/${botKey}/hermes:/data/hermes`,
      `${volumeRoot}/${botKey}/workspace:/workspace`,
      `${volumeRoot}/${botKey}/scratch:/scratch`,
    ]);
  });

  it("appends one writable bind per package manager when a cache is configured", () => {
    const cache = "/mnt/package-cache";
    const binds = buildBinds(volumeRoot, botKey, { sharedPackageCachePath: cache });
    expect(binds.slice(3)).toEqual([
      `${cache}/pnpm:/home/user/.pnpm-store:rw`,
      `${cache}/pip:/home/user/.cache/pip:rw`,
      `${cache}/go:/home/user/.cache/go-build:rw`,
      `${cache}/gradle:/home/user/.gradle:rw`,
    ]);
    expect(PACKAGE_CACHE_MOUNTS).toHaveLength(4);
  });

  it("keeps card mounts read-only next to the cache", () => {
    const binds = buildBinds(volumeRoot, botKey, {
      mounts: [{ source: "/srv/docs", containerPath: "/docs", readOnly: true }],
      allowedSources: ["/srv/docs"],
      sharedPackageCachePath: "/mnt/package-cache",
    });
    expect(binds[3]).toBe("/srv/docs:/docs:ro");
  });

  it("rejects a cache path that is not a plain absolute directory", () => {
    expect(() => buildBinds(volumeRoot, botKey, { sharedPackageCachePath: "relative/cache" })).toThrow(
      /shared package cache path/,
    );
    expect(() => buildBinds(volumeRoot, botKey, { sharedPackageCachePath: "/mnt/../etc" })).toThrow(
      /shared package cache path/,
    );
  });
});

describe("myrmidon(1.6.1-BOT-DISK-B) stored bot disk settings", () => {
  it("parses the cache path and ignores a blank one", () => {
    expect(parseBotDiskSettings({ botDisk: { sharedPackageCachePath: "/mnt/c" } })).toEqual({
      sharedPackageCachePath: "/mnt/c",
    });
    expect(parseBotDiskSettings({ botDisk: { sharedPackageCachePath: "  " } })).toEqual({});
    expect(parseBotDiskSettings(null)).toEqual({});
  });

  it("carries the botDisk and shared keys over a vendor write", () => {
    expect(
      preserveBotDiskGeneralKey({ botDisk: { sharedPackageCachePath: "/mnt/c" }, shared: { enabled: true }, other: 1 }),
    ).toEqual({ botDisk: { sharedPackageCachePath: "/mnt/c" }, shared: { enabled: true } });
    expect(preserveBotDiskGeneralKey(undefined)).toEqual({});
  });
});
