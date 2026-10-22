// server/src/myrmidon/bot-containers/fleet-move-service.myrmidon.test.ts

import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import {
  FleetMoveError,
  FleetMoveService,
  type FleetMoveRecord,
  type SiteAgentClient,
} from "./fleet-move-service.js";
import { createBotKeyLock } from "./bot-key-lock.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";

describe("FleetMoveService", () => {
  function createTestHarness(initialState: {
    srcSite?: string;
    dstSite?: string;
    botKey?: string;
  } = {}) {
    const botKey = initialState.botKey ?? "work-qa";
    const srcSite = initialState.srcSite ?? "myr-vm1";
    const dstSite = initialState.dstSite ?? "vm-core";

    const moveRecords = new Map<string, FleetMoveRecord>();
    let card = {
      agentId: "agent-123",
      adapterConfig: {
        container: {
          enabled: true,
          ...(srcSite === "local" ? {} : { host: srcSite }),
        },
        apiBaseUrl: `http://site-myr-vm1:8642`,
        instructions: "keep me",
      } as Record<string, any>,
    };

    const maintenanceCalls: string[] = [];
    const siteSnapshotCalls: string[] = [];
    const siteRestoreCalls: string[] = [];
    const siteQuarantineCalls: string[] = [];
    const driverCalls: Record<string, string[]> = {};
    const hooks = {
      enterError: null as Error | null,
      exitError: null as Error | null,
      restoreError: null as Error | null,
      dstStartError: null as Error | null,
      quarantineError: null as Error | null,
      startError: {} as Record<string, Error>,
    };

    // Container state per site: the source runs, everything else is missing.
    const states = new Map<string, "running" | "stopped" | "missing">();
    states.set(srcSite, "running");

    const mockDriver = (siteName: string): BotContainerDriver => {
      const calls = (driverCalls[siteName] ??= []);
      return {
        async status() {
          const state = states.get(siteName) ?? "missing";
          return { botKey, state, ...(state === "missing" ? {} : { gatewayPort: 18642 }) } as BotContainerStatus;
        },
        async list() { return []; },
        async templateDrift() { return { drifted: false, fields: [] }; },
        async create() { calls.push("create"); states.set(siteName, "stopped"); },
        async recreate() { calls.push("recreate"); },
        async writeProfile() { calls.push("writeProfile"); },
        async start() {
          calls.push("start");
          const failure = hooks.startError[siteName];
          if (failure) throw failure;
          states.set(siteName, "running");
        },
        async restart() { calls.push("restart"); },
        async stop() { calls.push("stop"); if (states.get(siteName) === "running") states.set(siteName, "stopped"); },
      };
    };

    const mockSiteAgent = (siteName: string): SiteAgentClient => ({
      async snapshot(key) {
        siteSnapshotCalls.push(`${siteName}:${key}`);
        return Readable.from([Buffer.from("tar.zst mock data payload")]);
      },
      async restore(key, stream) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        if (hooks.restoreError) throw hooks.restoreError;
        siteRestoreCalls.push(`${siteName}:${key}:${Buffer.concat(chunks).toString()}`);
      },
      async quarantine(key) {
        if (hooks.quarantineError) throw hooks.quarantineError;
        siteQuarantineCalls.push(`${siteName}:${key}`);
      },
    });

    const service = new FleetMoveService({
      async getMove(id) {
        return moveRecords.get(id) ?? null;
      },
      async getLatestMoveForBot(_companyId, key) {
        let latest: FleetMoveRecord | null = null;
        for (const m of moveRecords.values()) {
          if (m.botKey === key && (!latest || m.startedAt >= latest.startedAt)) latest = m;
        }
        return latest;
      },
      async createMove(params) {
        const record: FleetMoveRecord = {
          id: `move-${moveRecords.size + 1}`,
          companyId: params.companyId,
          botKey: params.botKey,
          srcSite: params.srcSite,
          dstSite: params.dstSite,
          phase: "init",
          phaseLog: [{ phase: "init", at: new Date().toISOString(), details: "Move created" }],
          startedAt: new Date(Date.now() + moveRecords.size),
        };
        moveRecords.set(record.id, record);
        return record;
      },
      async updateMove(id, update) {
        const existing = moveRecords.get(id)!;
        const updated: FleetMoveRecord = {
          ...existing,
          phase: update.phase,
          error: update.error ?? existing.error,
          completedAt: update.completedAt !== undefined ? update.completedAt : existing.completedAt,
          phaseLog: [
            ...existing.phaseLog,
            {
              phase: update.phase,
              at: new Date().toISOString(),
              details: update.details,
              error: update.error ?? undefined,
            },
          ],
        };
        moveRecords.set(id, updated);
        return updated;
      },

      async getDriverForSite(site) {
        return mockDriver(site);
      },
      async getSiteAgentClient(site) {
        return mockSiteAgent(site);
      },
      async getSiteUrl(site) {
        return site === "myr-vm1" ? "http://site-myr-vm1:9100" : "http://site-vm-core:9100";
      },

      async getAgentCard(key) {
        return key === botKey ? card : null;
      },
      async updateAgentCard(_agentId, nextConfig) {
        card = { ...card, adapterConfig: nextConfig as any };
      },

      async getBotSpec(key) {
        return {
          botKey: key,
          image: "example.com/bot@sha256:11",
          memoryMb: 1024,
          cpus: 1,
          pidsLimit: 256,
          network: "myrmidon-bots",
        };
      },
      async getCompiledProfile(key) {
        return {
          botKey: key,
          files: [],
          restartHash: "rh-123",
          filesHash: "fh-456",
        };
      },

      maintenance: {
        async enter(k) {
          if (hooks.enterError) throw hooks.enterError;
          maintenanceCalls.push(`enter:${k}`);
        },
        async exit(k) {
          if (hooks.exitError) throw hooks.exitError;
          maintenanceCalls.push(`exit:${k}`);
        },
      },
      lock: createBotKeyLock(),
    });

    return {
      service,
      getCard: () => card,
      moveRecords,
      maintenanceCalls,
      siteSnapshotCalls,
      siteRestoreCalls,
      siteQuarantineCalls,
      driverCalls,
      hooks,
      states,
    };
  }

  const MOVE = { companyId: "company-1", botKey: "work-qa" };

  it("completes full migration state machine with zero data loss and visible phase log", async () => {
    const harness = createTestHarness({ srcSite: "myr-vm1", dstSite: "vm-core" });

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("done");
    expect(result.completedAt).toBeDefined();

    // Verify all phases occurred in order in phaseLog
    expect(result.phaseLog.map((l) => l.phase)).toEqual([
      "init",
      "stop",
      "snapshot",
      "restore",
      "host",
      "reconcile",
      "apiBaseUrl",
      "done",
    ]);

    // The window is open for the whole move and closed once, at the end.
    expect(harness.maintenanceCalls).toEqual(["enter:work-qa", "exit:work-qa"]);

    expect(harness.driverCalls["myr-vm1"]).toContain("stop");
    expect(harness.siteSnapshotCalls).toEqual(["myr-vm1:work-qa"]);
    // Restore got the identical payload.
    expect(harness.siteRestoreCalls).toEqual(["vm-core:work-qa:tar.zst mock data payload"]);
    expect(harness.driverCalls["vm-core"]).toEqual(["create", "writeProfile", "start"]);
    expect(harness.siteQuarantineCalls).toEqual(["myr-vm1:work-qa"]);

    const finalCard = harness.getCard();
    expect(finalCard.adapterConfig.container.host).toBe("vm-core");
    expect(finalCard.adapterConfig.apiBaseUrl).toBe("http://site-vm-core:18642");
    // The rest of the card is untouched.
    expect(finalCard.adapterConfig.instructions).toBe("keep me");
    expect(harness.states.get("vm-core")).toBe("running");
    expect(harness.states.get("myr-vm1")).toBe("stopped");
  });

  it("supports roundtrip move work-qa myr-vm1 -> vm-core -> back to myr-vm1", async () => {
    const harness = createTestHarness({ srcSite: "myr-vm1", dstSite: "vm-core" });

    const move1 = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });
    expect(move1.phase).toBe("done");
    expect(harness.getCard().adapterConfig.container.host).toBe("vm-core");

    const move2 = await harness.service.startMove({ ...MOVE, dstSite: "myr-vm1" });
    expect(move2.phase).toBe("done");
    expect(harness.getCard().adapterConfig.container.host).toBe("myr-vm1");
    expect(harness.getCard().adapterConfig.apiBaseUrl).toBe("http://site-myr-vm1:18642");
    // The bot was not created a second time on the site it came from.
    expect(harness.driverCalls["myr-vm1"]!.filter((c) => c === "create")).toHaveLength(0);
  });

  it("moves to the local site by dropping container.host (the local driver has no host name)", async () => {
    const harness = createTestHarness({ srcSite: "myr-vm1", dstSite: "local" });

    const result = await harness.service.startMove({ ...MOVE, dstSite: "local" });

    expect(result.phase).toBe("done");
    const container = harness.getCard().adapterConfig.container;
    expect("host" in container).toBe(false);
    expect(harness.getCard().adapterConfig.apiBaseUrl).toBe("http://myrmidon-bot-work-qa:8642");
  });

  it("rolls back when restore fails: source restarted, window closed, card untouched", async () => {
    const harness = createTestHarness();
    harness.hooks.restoreError = new Error("restore refused: snapshot verification failed");

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("failed");
    expect(result.error).toContain("snapshot verification failed");
    expect(result.error).not.toContain("ROLLBACK INCOMPLETE");
    const failure = result.phaseLog[result.phaseLog.length - 1]!;
    expect(failure.details).toContain("Rolled back");

    // The bot runs again where it was and the window is closed.
    expect(harness.states.get("myr-vm1")).toBe("running");
    expect(harness.maintenanceCalls).toEqual(["enter:work-qa", "exit:work-qa"]);
    // The card was never changed, the source datadir was never quarantined.
    expect(harness.getCard().adapterConfig.container.host).toBe("myr-vm1");
    expect(harness.siteQuarantineCalls).toEqual([]);
  });

  it("rolls back after the card moved: destination stopped, card back on the source", async () => {
    const harness = createTestHarness();
    harness.hooks.startError["vm-core"] = new Error("docker start failed");

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("failed");
    expect(result.error).toContain("docker start failed");
    expect(harness.getCard().adapterConfig.container.host).toBe("myr-vm1");
    expect(harness.getCard().adapterConfig.apiBaseUrl).toBe("http://site-myr-vm1:18642");
    expect(harness.driverCalls["vm-core"]).toContain("stop");
    expect(harness.states.get("myr-vm1")).toBe("running");
    expect(harness.states.get("vm-core")).not.toBe("running");
    expect(harness.maintenanceCalls).toEqual(["enter:work-qa", "exit:work-qa"]);
    expect(harness.siteQuarantineCalls).toEqual([]);
  });

  it("says so when the rollback itself fails", async () => {
    const harness = createTestHarness();
    harness.hooks.restoreError = new Error("restore refused");
    harness.hooks.startError["myr-vm1"] = new Error("source will not start");

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("failed");
    expect(result.error).toContain("ROLLBACK INCOMPLETE");
    expect(result.error).toContain("source will not start");
  });

  it("does not touch the bot when the maintenance window cannot be entered", async () => {
    const harness = createTestHarness();
    harness.hooks.enterError = new Error("window opened by someone else");

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("failed");
    expect(harness.driverCalls["myr-vm1"] ?? []).toEqual([]);
    expect(harness.states.get("myr-vm1")).toBe("running");
    expect(harness.maintenanceCalls).toEqual([]);
  });

  it("rolls back when closing the window fails, before the source is quarantined", async () => {
    const harness = createTestHarness();
    harness.hooks.exitError = new Error("maintenance service down");

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("failed");
    expect(harness.siteQuarantineCalls).toEqual([]);
    expect(harness.getCard().adapterConfig.container.host).toBe("myr-vm1");
    expect(harness.states.get("myr-vm1")).toBe("running");
  });

  it("finishes the move when only the source quarantine fails, and says the datadir was kept", async () => {
    const harness = createTestHarness();
    harness.hooks.quarantineError = new Error("rename failed");

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("done");
    expect(result.phaseLog[result.phaseLog.length - 1]!.details).toContain("NOT quarantined");
    expect(harness.states.get("vm-core")).toBe("running");
  });

  it("resumes an unfinished move after its last completed phase without repeating earlier ones", async () => {
    const harness = createTestHarness();
    harness.states.set("myr-vm1", "stopped");
    harness.moveRecords.set("move-x", {
      id: "move-x",
      companyId: "company-1",
      botKey: "work-qa",
      srcSite: "myr-vm1",
      dstSite: "vm-core",
      phase: "restore",
      phaseLog: [],
      startedAt: new Date(),
    });

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("done");
    expect(harness.siteSnapshotCalls).toEqual([]);
    expect(harness.siteRestoreCalls).toEqual([]);
    expect(harness.getCard().adapterConfig.container.host).toBe("vm-core");
  });

  it("refuses a second destination while a move is unfinished, and a move to the site the bot is on", async () => {
    const harness = createTestHarness();
    harness.moveRecords.set("move-x", {
      id: "move-x",
      companyId: "company-1",
      botKey: "work-qa",
      srcSite: "myr-vm1",
      dstSite: "vm-core",
      phase: "stop",
      phaseLog: [],
      startedAt: new Date(),
    });

    await expect(harness.service.startMove({ ...MOVE, dstSite: "other" })).rejects.toBeInstanceOf(FleetMoveError);

    const settled = createTestHarness();
    await expect(settled.service.startMove({ ...MOVE, dstSite: "myr-vm1" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(settled.service.startMove({ companyId: "company-1", botKey: "nobody", dstSite: "vm-core" })).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("fails gracefully and records error in phase log when a phase throws", async () => {
    const harness = createTestHarness();
    vi.spyOn(harness.service["deps"], "getSiteAgentClient").mockRejectedValueOnce(
      new Error("connection timeout to site agent"),
    );

    const result = await harness.service.startMove({ ...MOVE, dstSite: "vm-core" });

    expect(result.phase).toBe("failed");
    expect(result.error).toContain("connection timeout to site agent");
    expect(result.phaseLog.some((l) => l.phase === "failed")).toBe(true);
    expect(harness.states.get("myr-vm1")).toBe("running");
  });
});
