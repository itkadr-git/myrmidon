import { describe, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Dockerode from "dockerode";
import { z } from "zod";
import { setTimeout } from "timers/promises";

import { botDiskApi } from "./bot-disk-api.js";
import { readBotDiskSettings, writeBotDiskSettings } from "./bot-disk-store.js";
import { dockerBotContainerDriver } from "./docker-driver.js";
import { buildBinds } from "./template.js";
import { BotContainerSpec, BotExtraMount } from "./driver.js";

describe("bot-disk functionality", () => {
  let db: any; // Mock DB for testing
  let mockDb: Record<string, any>;

  beforeEach(() => {
    mockDb = {};
    db = {
      select: () => db,
      from: () => db,
      where: () => db,
      then: (cb: any) => cb([{ general: { botDisk: { sharedPackageCachePath: undefined } } }]),
      insert: () => db,
      set: () => db,
      values: () => db,
      update: () => db,
      set: () => db,
      execute: () => Promise.resolve(),
    };
  });

  it("should read and write bot disk settings", async () => {
    const initialSettings = await readBotDiskSettings(db);
    expect(initialSettings).toEqual({ sharedPackageCachePath: undefined });

    const testPath = "/mnt/shared/package-cache";
    await writeBotDiskSettings(db, { sharedPackageCachePath: testPath });

    const updatedSettings = await readBotDiskSettings(db);
    expect(updatedSettings).toEqual({ sharedPackageCachePath: testPath });
  });

  it("should build correct binds with shared cache path", () => {
    const volumeRoot = "/tmp/volumes";
    const botKey = "test-bot-123";
    
    // Test without shared cache
    const bindsWithoutCache = buildBinds(volumeRoot, botKey, {});
    expect(bindsWithoutCache).toContain(`${volumeRoot}/${botKey}/profile:/home/user/.profile.d:ro`);
    
    // Test with shared cache
    const sharedCachePath = "/mnt/shared/package-cache";
    const bindsWithCache = buildBinds(volumeRoot, botKey, { 
      sharedPackageCachePath,
      allowedSources: []
    });
    
    expect(bindsWithCache).toContain(`${sharedCachePath}/pnpm:/home/user/.pnpm-store:rw`);
    expect(bindsWithCache).toContain(`${sharedCachePath}/pip:/home/user/.cache/pip:rw`);
    expect(bindsWithCache).toContain(`${sharedCachePath}/go:/home/user/.cache/go-build:rw`);
    expect(bindsWithCache).toContain(`${sharedCachePath}/gradle:/home/user/.gradle:rw`);
  });

  it("should update driver with shared cache path", () => {
    const config = {
      socketPath: "/var/run/docker.sock",
      volumeRoot: "/tmp/volumes",
      network: "test-network",
      allowlist: [],
      mountSources: [],
    };
    
    const driver = dockerBotContainerDriver(config);
    
    // Initially no shared cache
    const spec: BotContainerSpec = {
      botKey: "test-bot",
      image: "ubuntu:20.04",
      environment: {},
      extraMounts: [],
    };
    
    // This would be tested more thoroughly with actual docker integration
    expect(driver).toBeDefined();
    
    // Test updating the shared cache path
    const newPath = "/new/shared/cache";
    driver.updateSharedPackageCachePath(newPath);
    
    // Verify the driver has the update method
    expect(driver.updateSharedPackageCachePath).toBeDefined();
  });
});