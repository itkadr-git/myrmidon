// myrmidon(1.6.1-BOT-DISK-B): the shared package cache binds, the variables that
// point the tools at them, the stored settings and the fleetd no-op.
// Everything here is placeholder data: fake paths, keys and values.

import { describe, expect, it, vi } from "vitest";

import {
  botDiskCachePathProblem,
  botRoleGetsSharedCache,
  gitMirrorRepoProblem,
  mergeBotDiskSettings,
  normalizeStoredBotDiskSettings,
  patchBotDiskSettingsSchema,
  resolveBotDiskLayout,
  resolveBotDiskSettings,
  resolveSharedPackageCachePath,
} from "@paperclipai/shared";
import { FLEETD_PACKAGE_CACHE_NOTICE, fleetdBotContainerDriver } from "./fleetd-driver.js";
import type { BotContainerSpec } from "./driver.js";
import { buildBinds, GIT_MIRROR_MOUNT, packageCacheEnv, PACKAGE_CACHE_MOUNTS } from "./template.js";

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
      expect(botDiskCachePathProblem(bad)).not.toBeNull();
    }
    expect(botDiskCachePathProblem(cache)).toBeNull();
  });

  it("points every tool at its mount, the pnpm store on the workspace mount, and leaves pip out", () => {
    // myrmidon(1.6.2-BOT-DISK-C): /cache/pnpm and /workspace are two binds, and hard links
    // cannot cross a mount, so the default pnpm store sits beside the clones.
    expect(packageCacheEnv()).toEqual({
      npm_config_store_dir: "/workspace/.pnpm-store",
      GOMODCACHE: "/cache/go-mod",
      GOCACHE: "/cache/go-build",
      GRADLE_USER_HOME: "/cache/gradle",
    });
    expect(PACKAGE_CACHE_MOUNTS.map((mount) => mount.hostSubdir)).not.toContain("pip");
  });

  it("keeps the store on /cache/pnpm in shared mode and tells pnpm to clone, then copy", () => {
    expect(packageCacheEnv("shared")).toEqual({
      npm_config_store_dir: "/cache/pnpm",
      npm_config_package_import_method: "clone-or-copy",
      GOMODCACHE: "/cache/go-mod",
      GOCACHE: "/cache/go-build",
      GRADLE_USER_HOME: "/cache/gradle",
    });
  });

  it("binds the git mirror directory read-only, and only with a cache", () => {
    const binds = buildBinds(volumeRoot, botKey, { sharedPackageCachePath: cache, gitMirror: true });
    expect(binds.slice(3)).toEqual([
      `${cache}/pnpm:/cache/pnpm:rw`,
      `${cache}/go-mod:/cache/go-mod:rw`,
      `${cache}/go-build:/cache/go-build:rw`,
      `${cache}/gradle:/cache/gradle:rw`,
      `${cache}/git:/cache/git:ro`,
    ]);
    expect(buildBinds(volumeRoot, botKey, { gitMirror: true })).toHaveLength(3);
    expect(buildBinds(volumeRoot, botKey, { sharedPackageCachePath: cache })).toHaveLength(7);
    expect(GIT_MIRROR_MOUNT.containerPath).toBe("/cache/git");
  });
});

describe("myrmidon(1.6.1-BOT-DISK-B) the cache path in general.botDisk", () => {
  it("reads a valid stored path and drops an invalid one without touching the lifecycle keys", () => {
    expect(resolveSharedPackageCachePath({ enabled: false, sharedPackageCachePath: cache })).toBe(cache);
    expect(resolveSharedPackageCachePath({ sharedPackageCachePath: "relative" })).toBeUndefined();
    expect(resolveSharedPackageCachePath({ sharedPackageCachePath: 7 })).toBeUndefined();
    expect(resolveSharedPackageCachePath(undefined)).toBeUndefined();
    expect(normalizeStoredBotDiskSettings({ enabled: false, sharedPackageCachePath: "/srv/../etc" })).toEqual({
      enabled: false,
    });
  });

  it("reports the path in the settings, not in the sources", () => {
    const resolved = resolveBotDiskSettings({ stored: { sharedPackageCachePath: cache } });
    expect(resolved.settings.sharedPackageCachePath).toBe(cache);
    expect(Object.keys(resolved.sources).sort()).toEqual(["enabled", "idleTtlMs"]);
    expect("sharedPackageCachePath" in resolveBotDiskSettings({}).settings).toBe(false);
  });

  it("keeps the path across a lifecycle patch and clears it on null or an empty string", () => {
    const base = { enabled: true, idleTtlMs: 3_600_000, sharedPackageCachePath: cache };
    expect(mergeBotDiskSettings(base, { enabled: false })).toEqual({ ...base, enabled: false });
    expect(mergeBotDiskSettings(base, { sharedPackageCachePath: null })).toEqual({ enabled: true, idleTtlMs: 3_600_000 });
    expect(mergeBotDiskSettings(base, { sharedPackageCachePath: "" })).toEqual({ enabled: true, idleTtlMs: 3_600_000 });
    expect(mergeBotDiskSettings({ enabled: true, idleTtlMs: 3_600_000 }, { sharedPackageCachePath: cache })).toEqual(base);
  });

  it("accepts a plain absolute path, null or an empty string in a PATCH", () => {
    expect(patchBotDiskSettingsSchema.safeParse({ sharedPackageCachePath: cache }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({ sharedPackageCachePath: null }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({ sharedPackageCachePath: "" }).success).toBe(true);
    for (const bad of ["relative", "/srv/../etc", "/", "/srv/cache/", "/srv//cache"]) {
      expect(patchBotDiskSettingsSchema.safeParse({ sharedPackageCachePath: bad }).success).toBe(false);
    }
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

describe("myrmidon(1.6.2-BOT-DISK-C) git mirror and pnpm store settings", () => {
  it("accepts owner/repo names only", () => {
    for (const ok of ["owner/repo", "Some-Org/my.repo_1", "a/b"]) expect(gitMirrorRepoProblem(ok)).toBeNull();
    for (const bad of ["repo", "a/b/c", "-a/b", "a-/b", "a/..", "a/.", "a/b.git", "a b/c", "a/b c", "/b", "a/", "../x/y"]) {
      expect(gitMirrorRepoProblem(bad), bad).not.toBeNull();
    }
  });

  it("fills the defaults, lower-cases and de-duplicates the repositories, and needs a cache path", () => {
    expect(resolveBotDiskLayout({ sharedPackageCachePath: cache })).toEqual({
      sharedPackageCachePath: cache,
      gitMirrorRepos: [],
      gitMirrorRefreshMs: 15 * 60 * 1000,
      pnpmStore: "workspace",
      sharedCacheRoles: ["engineer", "reviewer", "devops", "release", "qa"],
    });
    const layout = resolveBotDiskLayout({
      sharedPackageCachePath: cache,
      gitMirrorRepos: ["Owner/Repo", "owner/repo", "o2/r2"],
      gitMirrorRefreshMs: 120_000,
      pnpmStore: "shared",
    });
    expect(layout.gitMirrorRepos).toEqual(["owner/repo", "o2/r2"]);
    expect(layout.gitMirrorRefreshMs).toBe(120_000);
    expect(layout.pnpmStore).toBe("shared");
    // No cache path: the mirrors have nowhere to live.
    expect(resolveBotDiskLayout({ gitMirrorRepos: ["owner/repo"] }).gitMirrorRepos).toEqual([]);
    expect(resolveBotDiskLayout(undefined).pnpmStore).toBe("workspace");
  });

  it("drops an invalid stored value and keeps the rest", () => {
    const values = normalizeStoredBotDiskSettings({
      enabled: false,
      gitMirrorRepos: ["bad name"],
      gitMirrorRefreshMs: 5,
      pnpmStore: "elsewhere",
    });
    expect(values).toEqual({ enabled: false });
  });

  it("patches the three keys and clears each on null, keeping the lifecycle keys", () => {
    const base = { enabled: true, idleTtlMs: 3_600_000, sharedPackageCachePath: cache };
    const set = mergeBotDiskSettings(base, { gitMirrorRepos: ["owner/repo"], gitMirrorRefreshMs: 300_000, pnpmStore: "shared" });
    expect(set).toEqual({ ...base, gitMirrorRepos: ["owner/repo"], gitMirrorRefreshMs: 300_000, pnpmStore: "shared" });
    expect(mergeBotDiskSettings(set, { enabled: false })).toEqual({ ...set, enabled: false });
    expect(mergeBotDiskSettings(set, { gitMirrorRepos: null, gitMirrorRefreshMs: null, pnpmStore: null })).toEqual(base);
    expect(mergeBotDiskSettings(set, { gitMirrorRepos: [] }).gitMirrorRepos).toBeUndefined();
  });

  it("validates a PATCH of the three keys", () => {
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRepos: ["owner/repo"], gitMirrorRefreshMs: 60_000, pnpmStore: "workspace" }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRepos: null, gitMirrorRefreshMs: null, pnpmStore: null }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRepos: ["a/b.git"] }).success).toBe(false);
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRefreshMs: 1000 }).success).toBe(false);
    expect(patchBotDiskSettingsSchema.safeParse({ pnpmStore: "x" }).success).toBe(false);
  });
});

describe("myrmidon(1.6.2-BOT-DISK-C) the roles that get the cache", () => {
  it("defaults to the coding roles, case-insensitively, and excludes everything else", () => {
    const { sharedCacheRoles } = resolveBotDiskLayout({ sharedPackageCachePath: cache });
    for (const role of ["engineer", "Reviewer", "devops", "release", "qa"]) expect(botRoleGetsSharedCache(sharedCacheRoles, role), role).toBe(true);
    for (const role of ["marketing", "general", "", undefined, null]) expect(botRoleGetsSharedCache(sharedCacheRoles, role)).toBe(false);
  });

  it("is editable: a stored list replaces the default, [] means no bot, null restores the default", () => {
    const base = { enabled: true, idleTtlMs: 3_600_000, sharedPackageCachePath: cache };
    const set = mergeBotDiskSettings(base, { sharedCacheRoles: ["marketing"] });
    expect(resolveBotDiskLayout(set).sharedCacheRoles).toEqual(["marketing"]);
    expect(resolveBotDiskLayout(mergeBotDiskSettings(base, { sharedCacheRoles: [] })).sharedCacheRoles).toEqual([]);
    expect(resolveBotDiskLayout(mergeBotDiskSettings(set, { sharedCacheRoles: null })).sharedCacheRoles).toContain("engineer");
    expect(patchBotDiskSettingsSchema.safeParse({ sharedCacheRoles: ["Bad Role"] }).success).toBe(false);
  });
});
