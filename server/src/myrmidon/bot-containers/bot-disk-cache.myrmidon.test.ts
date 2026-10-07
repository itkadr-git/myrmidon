// myrmidon(1.6.1-BOT-DISK-B): the shared package cache binds, the variables that
// point the tools at them, the stored settings and the fleetd no-op.
// Everything here is placeholder data: fake paths, keys and values.

import { describe, expect, it, vi } from "vitest";

import {
  botDiskCachePathProblem,
  botDiskPnpmImportMethodProblem,
  botDiskPnpmStoreDirProblem,
  botDiskPnpmStoreDirWarning,
  botDiskPnpmWarnings,
  migrateBotDiskPnpm,
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
import {
  buildBinds,
  buildHelperBinds,
  DEFAULT_PNPM_IMPORT_METHOD,
  DEFAULT_PNPM_STORE_DIR,
  GIT_MIRROR_MOUNT,
  packageCacheEnv,
  PACKAGE_CACHE_MOUNTS,
  PNPM_STORE_ROOTS,
} from "./template.js";

const volumeRoot = "/srv/bots";
const botKey = "agent-a";
const cache = "/srv/package-cache";

describe("myrmidon(1.6.1-BOT-DISK-B) buildBinds with the shared package cache", () => {
  it("writes ONE bind, the bot's whole tree, when no cache is configured", () => {
    // myrmidon(BOT-DISK-D): hard links cannot cross mounts, so hermes, workspace and scratch
    // are directories of one mount, not three binds.
    expect(buildBinds(volumeRoot, botKey)).toEqual([`${volumeRoot}/${botKey}:/bot`]);
  });

  it("gives a HELPER container the three narrow binds of the same host directories", () => {
    expect(buildHelperBinds(volumeRoot, botKey)).toEqual([
      `${volumeRoot}/${botKey}/hermes:/data/hermes`,
      `${volumeRoot}/${botKey}/workspace:/workspace`,
      `${volumeRoot}/${botKey}/scratch:/scratch`,
    ]);
  });

  it("refuses a card mount at or under the single mount, /data, or the link paths", () => {
    for (const containerPath of ["/bot", "/bot/x", "/data", "/data/x", "/workspace", "/scratch/y"]) {
      expect(() =>
        buildBinds(volumeRoot, botKey, {
          mounts: [{ source: "/srv/docs", containerPath, readOnly: true }],
          allowedSources: ["/srv/docs"],
        }),
      ).toThrow(/reserved by the driver/);
    }
  });

  it("appends one writable bind per cache, under /cache, after the card mounts", () => {
    const binds = buildBinds(volumeRoot, botKey, {
      mounts: [{ source: "/srv/docs", containerPath: "/docs", readOnly: true }],
      allowedSources: ["/srv/docs"],
      sharedPackageCachePath: cache,
    });
    expect(binds.slice(1)).toEqual([
      "/srv/docs:/docs:ro",
      `${cache}/pnpm:/cache/pnpm:rw`,
      `${cache}/pnpm-store:/cache/pnpm-store:rw`,
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
    expect(buildBinds(volumeRoot, botKey, { mounts, allowedSources: ["/srv/docs"] })[1]).toBe(
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

  it("points every tool at its mount, the shared pnpm store with clone import, and leaves pip out", () => {
    // myrmidon(1.6.5-BOT-DISK-H8a): /cache/pnpm is only a download (metadata) cache; the store
    // is the per-partition /cache/pnpm-store mount, imported by reflink (strictly `clone`).
    expect(packageCacheEnv()).toEqual({
      npm_config_cache_dir: "/cache/pnpm",
      GOMODCACHE: "/cache/go-mod",
      GOCACHE: "/cache/go-build",
      GRADLE_USER_HOME: "/cache/gradle",
      npm_config_store_dir: "/cache/pnpm-store",
      npm_config_package_import_method: "clone",
    });
    expect(DEFAULT_PNPM_STORE_DIR).toBe("/cache/pnpm-store");
    expect(DEFAULT_PNPM_IMPORT_METHOD).toBe("clone");
    expect(PNPM_STORE_ROOTS).toContain("/cache/pnpm-store");
    expect(PACKAGE_CACHE_MOUNTS.map((mount) => mount.hostSubdir)).not.toContain("pip");
  });

  it("mounts the store read-write from <cache>/pnpm-store to every bot of the cache, and the env names the same path", () => {
    // myrmidon(1.6.5-BOT-DISK-H8a): the default store is a mount, so it is in the bind list.
    const binds = buildBinds(volumeRoot, botKey, { sharedPackageCachePath: cache });
    expect(binds).toContain(`${cache}/pnpm-store:/cache/pnpm-store:rw`);
    const mount = PACKAGE_CACHE_MOUNTS.find((m) => m.hostSubdir === "pnpm-store");
    expect(mount?.containerPath).toBe(packageCacheEnv().npm_config_store_dir);
    // Without a cache there is no store mount.
    expect(buildBinds(volumeRoot, botKey).join()).not.toContain("pnpm-store");
  });

  it("never lets the pnpm store be the /cache/pnpm mount, whatever the settings", () => {
    const env = packageCacheEnv({ storeDir: "/data/hermes/.pnpm-store", importMethod: "copy" });
    expect(env.npm_config_store_dir).toBe("/data/hermes/.pnpm-store");
    expect(env.npm_config_package_import_method).toBe("copy");
    expect(Object.values(env).filter((value) => value === "/cache/pnpm")).toEqual(["/cache/pnpm"]);
    expect(env.npm_config_cache_dir).toBe("/cache/pnpm");
    expect(env.npm_config_store_dir).not.toBe("/cache/pnpm");
  });

  it("binds the git mirror directory read-only, and only with a cache", () => {
    const binds = buildBinds(volumeRoot, botKey, { sharedPackageCachePath: cache, gitMirror: true });
    expect(binds.slice(1)).toEqual([
      `${cache}/pnpm:/cache/pnpm:rw`,
      `${cache}/pnpm-store:/cache/pnpm-store:rw`,
      `${cache}/go-mod:/cache/go-mod:rw`,
      `${cache}/go-build:/cache/go-build:rw`,
      `${cache}/gradle:/cache/gradle:rw`,
      `${cache}/git:/cache/git:ro`,
    ]);
    expect(buildBinds(volumeRoot, botKey, { gitMirror: true })).toHaveLength(1);
    expect(buildBinds(volumeRoot, botKey, { sharedPackageCachePath: cache })).toHaveLength(6);
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
      pnpmStoreDir: "/cache/pnpm-store",
      pnpmImportMethod: "clone",
      sharedCacheRoles: ["engineer", "reviewer", "devops", "release", "qa"],
    });
    const layout = resolveBotDiskLayout({
      sharedPackageCachePath: cache,
      gitMirrorRepos: ["Owner/Repo", "owner/repo", "o2/r2"],
      gitMirrorRefreshMs: 120_000,
      pnpmStoreDir: "/scratch/store",
      pnpmImportMethod: "copy",
    });
    expect(layout.gitMirrorRepos).toEqual(["owner/repo", "o2/r2"]);
    expect(layout.gitMirrorRefreshMs).toBe(120_000);
    expect(layout.pnpmStoreDir).toBe("/scratch/store");
    expect(layout.pnpmImportMethod).toBe("copy");
    // No cache path: the mirrors have nowhere to live.
    expect(resolveBotDiskLayout({ gitMirrorRepos: ["owner/repo"] }).gitMirrorRepos).toEqual([]);
    expect(resolveBotDiskLayout(undefined).pnpmStoreDir).toBe("/cache/pnpm-store");
    expect(resolveBotDiskLayout(undefined).pnpmImportMethod).toBe("clone");
    // The former pnpmStore key is gone: a stored value is ignored.
    expect(resolveBotDiskLayout({ pnpmStore: "shared" }).pnpmStoreDir).toBe("/cache/pnpm-store");
  });

  it("drops an invalid stored value and keeps the rest", () => {
    const values = normalizeStoredBotDiskSettings({
      enabled: false,
      gitMirrorRepos: ["bad name"],
      gitMirrorRefreshMs: 5,
      pnpmStoreDir: "/cache/pnpm/store",
      pnpmImportMethod: "no-such-method",
    });
    expect(values).toEqual({ enabled: false });
  });

  it("patches the keys and clears each on null, keeping the lifecycle keys", () => {
    const base = { enabled: true, idleTtlMs: 3_600_000, sharedPackageCachePath: cache };
    const patch = { gitMirrorRepos: ["owner/repo"], gitMirrorRefreshMs: 300_000, pnpmStoreDir: "/data/hermes/.store", pnpmImportMethod: "copy" } satisfies Parameters<typeof mergeBotDiskSettings>[1];
    const set = mergeBotDiskSettings(base, patch);
    expect(set).toEqual({ ...base, ...patch });
    expect(mergeBotDiskSettings(set, { enabled: false })).toEqual({ ...set, enabled: false });
    expect(mergeBotDiskSettings(set, { gitMirrorRepos: null, gitMirrorRefreshMs: null, pnpmStoreDir: null, pnpmImportMethod: null })).toEqual(base);
    expect(mergeBotDiskSettings(set, { gitMirrorRepos: [] }).gitMirrorRepos).toBeUndefined();
  });

  it("validates a PATCH of the keys; the pnpm store is the shared mount or inside the bot's own tree", () => {
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRepos: ["owner/repo"], gitMirrorRefreshMs: 60_000, pnpmStoreDir: "/cache/pnpm-store", pnpmImportMethod: "clone" }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRepos: null, gitMirrorRefreshMs: null, pnpmStoreDir: null, pnpmImportMethod: null }).success).toBe(true);
    for (const bad of ["/cache/pnpm", "/cache/pnpm/store", "/srv/store", "/workspace", "/workspace/", "relative", "/workspace/../etc", "/tmp/store"]) {
      expect(patchBotDiskSettingsSchema.safeParse({ pnpmStoreDir: bad }).success, bad).toBe(false);
      expect(botDiskPnpmStoreDirProblem(bad), bad).not.toBeNull();
    }
    expect(botDiskPnpmStoreDirProblem("/bot/.pnpm-store")).toBeNull();
    expect(botDiskPnpmStoreDirProblem("/cache/pnpm-store")).toBeNull();
    expect(botDiskPnpmStoreDirProblem("/cache/pnpm-store/v10")).toBeNull();
    expect(botDiskPnpmStoreDirProblem("/cache/pnpm-store2")).not.toBeNull();
    expect(patchBotDiskSettingsSchema.safeParse({ pnpmImportMethod: "reflink" }).success).toBe(false);
    // The former key is no longer accepted (the schema is strict).
    expect(patchBotDiskSettingsSchema.safeParse({ pnpmStore: "workspace" }).success).toBe(false);
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRepos: ["a/b.git"] }).success).toBe(false);
    expect(patchBotDiskSettingsSchema.safeParse({ gitMirrorRefreshMs: 1000 }).success).toBe(false);
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

describe("myrmidon(1.6.5-BOT-DISK-H8a) pnpm store and import method", () => {
  it("accepts clone and copy, and refuses clone-or-copy and hardlink with a message that says why", () => {
    for (const ok of ["clone", "copy"]) {
      expect(botDiskPnpmImportMethodProblem(ok), ok).toBeNull();
      expect(patchBotDiskSettingsSchema.safeParse({ pnpmImportMethod: ok }).success, ok).toBe(true);
    }
    const refused = botDiskPnpmImportMethodProblem("clone-or-copy");
    expect(refused).toMatch(/clone-or-copy is not allowed.*silently/);
    expect(botDiskPnpmImportMethodProblem("hardlink")).toMatch(/hardlink is not allowed/);
    const parsed = patchBotDiskSettingsSchema.safeParse({ pnpmImportMethod: "clone-or-copy" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.message).join("\n")).toMatch(/pnpmImportMethod clone-or-copy is not allowed/);
  });

  it("warns, does not refuse, a store inside the bot's own tree (/workspace); the shared store draws none", () => {
    expect(botDiskPnpmStoreDirProblem("/workspace/.pnpm-store")).toBeNull();
    expect(patchBotDiskSettingsSchema.safeParse({ pnpmStoreDir: "/workspace/.my-store" }).success).toBe(true);
    expect(botDiskPnpmStoreDirWarning("/workspace/.my-store")).toMatch(/store per bot.*\/cache\/pnpm-store/);
    expect(botDiskPnpmStoreDirWarning("/scratch/store")).not.toBeNull();
    expect(botDiskPnpmStoreDirWarning("/cache/pnpm-store")).toBeNull();
    expect(botDiskPnpmStoreDirWarning("/srv/elsewhere")).toBeNull(); // refused, not warned
    expect(botDiskPnpmWarnings({ pnpmStoreDir: "/workspace/.my-store", pnpmImportMethod: "clone" })).toHaveLength(1);
    expect(botDiskPnpmWarnings({})).toEqual([]);
    expect(botDiskPnpmWarnings(undefined)).toEqual([]);
    // The warning does not change the value in force.
    expect(resolveBotDiskLayout({ pnpmStoreDir: "/workspace/.my-store" }).pnpmStoreDir).toBe("/workspace/.my-store");
  });

  it("migrates the values an earlier release stored, and says so", () => {
    // BOT-DISK-D wrote the per-bot store and hardlink (or clone-or-copy).
    const legacy = { pnpmStoreDir: "/workspace/.pnpm-store", pnpmImportMethod: "hardlink" };
    expect(migrateBotDiskPnpm(legacy)).toEqual({
      pnpmStoreDir: "/cache/pnpm-store",
      pnpmImportMethod: "clone",
      notes: [expect.stringMatching(/\/workspace\/\.pnpm-store.*\/cache\/pnpm-store/), expect.stringMatching(/hardlink is read as clone/)],
    });
    expect(migrateBotDiskPnpm({ pnpmImportMethod: "clone-or-copy" }).pnpmImportMethod).toBe("clone");
    // Read through the settings: layout, normalized values and the notes of the log.
    expect(resolveBotDiskLayout({ ...legacy, sharedPackageCachePath: cache })).toMatchObject({
      pnpmStoreDir: "/cache/pnpm-store",
      pnpmImportMethod: "clone",
    });
    expect(normalizeStoredBotDiskSettings(legacy)).toEqual({ pnpmStoreDir: "/cache/pnpm-store", pnpmImportMethod: "clone" });
    expect(botDiskPnpmWarnings(legacy)).toHaveLength(2);
    // A value that is already today's, or another valid one, is kept, with no note.
    expect(migrateBotDiskPnpm({ pnpmStoreDir: "/data/hermes/.store", pnpmImportMethod: "copy" })).toEqual({
      pnpmStoreDir: "/data/hermes/.store",
      pnpmImportMethod: "copy",
      notes: [],
    });
    // An unknown method is dropped to the default (the lenient reader), never kept.
    expect(normalizeStoredBotDiskSettings({ pnpmImportMethod: "reflink" })).toEqual({});
    expect(resolveBotDiskLayout({ pnpmImportMethod: "reflink" } as never).pnpmImportMethod).toBe("clone");
    // A migrated value is what a later write persists.
    expect(mergeBotDiskSettings(normalizeStoredBotDiskSettings(legacy) as Parameters<typeof mergeBotDiskSettings>[0], { enabled: true })).toMatchObject({
      pnpmStoreDir: "/cache/pnpm-store",
      pnpmImportMethod: "clone",
    });
  });
});
