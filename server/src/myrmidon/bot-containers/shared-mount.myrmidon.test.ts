import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHARED_MOUNT_SETTINGS,
  ensureSharedDirectory,
  getEffectiveSharedMountSettings,
  getSharedMountHostPath,
  isBotAllowedSharedAccess,
  migrateHardlinkCopies,
  prepareBotSharedMount,
  resolveBotSharedMount,
  resolveSpecSharedMount,
} from "./shared-mount.js";
import { botContainerSpec, readBotContainerAgentConfig } from "./agent-config.js";
import { buildBinds, withSharedMount, BotContainerTemplateError } from "./template.js";
import { buildCreateContainerRequestBody, type DockerDriverConfig } from "./docker-driver.js";

const VALID_CONTAINER = {
  enabled: true,
  image: "myrmidon-hermes:1.1.0",
  memoryMb: 1536,
  cpus: 1,
  pidsLimit: 256,
};

const DRIVER_CONFIG: Pick<DockerDriverConfig, "volumeRoot" | "network" | "allowlist" | "mountSources" | "devbuild"> = {
  volumeRoot: "/srv/myrmidon/bots",
  network: "myrmidon-bots",
  allowlist: ["myrmidon-hermes:*"],
  mountSources: [],
  devbuild: { host: null, user: "", base: "" },
};

describe("shared-mount rules", () => {
  it("merges settings over the defaults", () => {
    expect(getEffectiveSharedMountSettings(undefined)).toEqual(DEFAULT_SHARED_MOUNT_SETTINGS);
    expect(getEffectiveSharedMountSettings({ enabled: true, writable: true })).toEqual({
      ...DEFAULT_SHARED_MOUNT_SETTINGS,
      enabled: true,
      writable: true,
    });
  });

  it("allows nobody when disabled, everybody on an empty allowlist, listed bots otherwise", () => {
    const base = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: true };
    expect(isBotAllowedSharedAccess("a", { ...base, enabled: false })).toBe(false);
    expect(isBotAllowedSharedAccess("a", base)).toBe(true);
    expect(isBotAllowedSharedAccess("a", { ...base, allowedBots: ["a", "b"] })).toBe(true);
    expect(isBotAllowedSharedAccess("c", { ...base, allowedBots: ["a", "b"] })).toBe(false);
  });

  it("takes the host path from the setting, else from the volume root", () => {
    expect(getSharedMountHostPath({ hostPath: "/custom/shared" }, "/vol")).toBe("/custom/shared");
    expect(getSharedMountHostPath({}, "/vol")).toBe("/vol/shared");
  });

  it("resolves the mount of one bot: off by default, allowlist per agent id, writable flag", () => {
    expect(resolveBotSharedMount("a", undefined)).toBeUndefined();
    expect(resolveBotSharedMount("a", { enabled: false })).toBeUndefined();
    expect(resolveBotSharedMount("a", { enabled: true })).toEqual({ writable: false });
    expect(resolveBotSharedMount("a", { enabled: true, writable: true, hostPath: "/s" })).toEqual({
      hostPath: "/s",
      writable: true,
    });
    expect(resolveBotSharedMount("a", { enabled: true, allowedBots: ["a"] })).toEqual({ writable: false });
    expect(resolveBotSharedMount("b", { enabled: true, allowedBots: ["a"] })).toBeUndefined();
    expect(resolveBotSharedMount(undefined, { enabled: true, allowedBots: ["a"] })).toBeUndefined();
  });

  it("fills the driver's volume root into the default host path", () => {
    expect(resolveSpecSharedMount({ sharedMount: { writable: true } }, "/vol")).toEqual({
      hostPath: "/vol/shared",
      writable: true,
    });
    expect(resolveSpecSharedMount({}, "/vol")).toBeUndefined();
  });
});

describe("shared mount reaches the container create body", () => {
  it("readBotContainerAgentConfig carries the mount only for an allowed bot, spec keeps it", () => {
    const settings = { enabled: true, writable: true, allowedBots: ["agent-a"] };
    const allowed = readBotContainerAgentConfig("hermes_gateway", { container: VALID_CONTAINER }, settings, "agent-a");
    expect(allowed.ok && allowed.config.sharedMount).toEqual({ writable: true });
    const denied = readBotContainerAgentConfig("hermes_gateway", { container: VALID_CONTAINER }, settings, "agent-b");
    expect(denied.ok && "sharedMount" in denied.config).toBe(false);
    const plain = readBotContainerAgentConfig("hermes_gateway", { container: VALID_CONTAINER });
    expect(plain.ok && "sharedMount" in plain.config).toBe(false);
    if (!allowed.ok) throw new Error("unreachable");
    expect(botContainerSpec("agent-a", allowed.config, "myrmidon-bots").sharedMount).toEqual({ writable: true });
  });

  it("binds /shared last, read-write or read-only according to the setting", () => {
    const rw = buildBinds("/vol", "agent-a", { sharedMount: { hostPath: "/vol/shared", writable: true } });
    expect(rw[rw.length - 1]).toBe("/vol/shared:/shared:rw");
    const ro = buildBinds("/vol", "agent-a", { sharedMount: { hostPath: "/vol/shared", writable: false } });
    expect(ro[ro.length - 1]).toBe("/vol/shared:/shared:ro");
    expect(buildBinds("/vol", "agent-a").some((bind) => bind.includes(":/shared"))).toBe(false);
  });

  it("the create body of a bot with a shared mount has the /shared bind; without it, none", () => {
    const spec = {
      botKey: "agent-a",
      image: "myrmidon-hermes:1.1.0",
      memoryMb: 1536,
      cpus: 1,
      pidsLimit: 256,
      network: "myrmidon-bots",
    };
    const withMount = buildCreateContainerRequestBody({ ...spec, sharedMount: { writable: false } }, DRIVER_CONFIG);
    expect(withMount.HostConfig.Binds).toContain("/srv/myrmidon/bots/shared:/shared:ro");
    const custom = buildCreateContainerRequestBody(
      { ...spec, sharedMount: { hostPath: "/srv/team-shared", writable: true } },
      DRIVER_CONFIG,
    );
    expect(custom.HostConfig.Binds).toContain("/srv/team-shared:/shared:rw");
    const without = buildCreateContainerRequestBody(spec, DRIVER_CONFIG);
    expect(without.HostConfig.Binds.some((bind) => bind.includes(":/shared"))).toBe(false);
  });

  it("refuses a host path that could smuggle bind options or is not a plain absolute path", () => {
    for (const hostPath of ["/srv/a:rw,bind-propagation=shared", "relative/dir", "/srv/../etc", "/srv/a,b"]) {
      expect(() => withSharedMount([], { hostPath, writable: false })).toThrow(BotContainerTemplateError);
    }
  });
});

describe("host side: directory and migration never lose data", () => {
  let tempDir: string;
  let botVolume: string;
  let sharedHost: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-mount-test-"));
    botVolume = path.join(tempDir, "bot-volume");
    sharedHost = path.join(tempDir, "shared");
    await fs.mkdir(botVolume, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates a missing shared directory and leaves an existing one untouched", async () => {
    await ensureSharedDirectory(sharedHost, true);
    expect((await fs.stat(sharedHost)).isDirectory()).toBe(true);
    await fs.chmod(sharedHost, 0o700);
    await ensureSharedDirectory(sharedHost, true);
    expect((await fs.stat(sharedHost)).mode & 0o777).toBe(0o700);
  });

  it("moves old files into the shared directory and removes the emptied old directory", async () => {
    const old = path.join(botVolume, "shared");
    await fs.mkdir(old);
    await fs.writeFile(path.join(old, "a.txt"), "A");
    await fs.mkdir(sharedHost);
    const result = await migrateHardlinkCopies(botVolume, sharedHost);
    expect(result).toEqual({ moved: ["a.txt"], kept: [] });
    expect(await fs.readFile(path.join(sharedHost, "a.txt"), "utf8")).toBe("A");
    await expect(fs.lstat(old)).rejects.toThrow();
  });

  it("keeps a file whose name is already taken, and does not delete the old directory", async () => {
    const old = path.join(botVolume, "shared");
    await fs.mkdir(old);
    await fs.writeFile(path.join(old, "clash.txt"), "mine");
    await fs.writeFile(path.join(old, "free.txt"), "free");
    await fs.mkdir(sharedHost);
    await fs.writeFile(path.join(sharedHost, "clash.txt"), "theirs");
    const result = await migrateHardlinkCopies(botVolume, sharedHost);
    expect(result.moved).toEqual(["free.txt"]);
    expect(result.kept).toEqual(["clash.txt"]);
    // nothing was lost: the clashing file survives in the old place, the target is untouched
    expect(await fs.readFile(path.join(old, "clash.txt"), "utf8")).toBe("mine");
    expect(await fs.readFile(path.join(sharedHost, "clash.txt"), "utf8")).toBe("theirs");
  });

  it("keeps everything when a rename fails (no rm of the unmoved files)", async () => {
    const old = path.join(botVolume, "shared");
    await fs.mkdir(old);
    await fs.writeFile(path.join(old, "stuck.txt"), "data");
    await fs.mkdir(sharedHost);
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).endsWith("stuck.txt")) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      return realRename(from, to);
    });
    const result = await migrateHardlinkCopies(botVolume, sharedHost);
    expect(result.kept).toEqual(["stuck.txt"]);
    expect(await fs.readFile(path.join(old, "stuck.txt"), "utf8")).toBe("data");
  });

  it("does not touch a symlink named shared and creates no symlink", async () => {
    const elsewhere = path.join(tempDir, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "keep.txt"), "x");
    await fs.symlink(elsewhere, path.join(botVolume, "shared"), "dir");
    const result = await migrateHardlinkCopies(botVolume, sharedHost);
    expect(result).toEqual({ moved: [], kept: [] });
    expect(await fs.readFile(path.join(elsewhere, "keep.txt"), "utf8")).toBe("x");
    // a bot without an old directory gets none made for it
    const other = path.join(tempDir, "other-bot");
    await fs.mkdir(other);
    await prepareBotSharedMount(other, { hostPath: sharedHost, writable: false });
    await expect(fs.lstat(path.join(other, "shared"))).rejects.toThrow();
  });

  it("prepareBotSharedMount never throws: a bad path comes back as a warning", async () => {
    const blocker = path.join(tempDir, "file");
    await fs.writeFile(blocker, "x");
    const result = await prepareBotSharedMount(botVolume, { hostPath: path.join(blocker, "sub"), writable: false });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
