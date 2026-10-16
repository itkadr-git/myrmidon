// server/src/myrmidon/bot-containers/fleet-move-service.myrmidon.test.ts

import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import {
  FleetMoveService,
  type FleetMoveRecord,
  type SiteAgentClient,
  type MovePhase,
} from "./fleet-move-service.js";
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
          botKey,
          host: srcSite,
        },
        apiBaseUrl: `http://site-a.example.test:8642`,
      },
    };

    const maintenanceCalls: string[] = [];
    const siteSnapshotCalls: string[] = [];
    const siteRestoreCalls: string[] = [];
    const siteQuarantineCalls: string[] = [];
    const driverCalls: Record<string, string[]> = {
      [srcSite]: [],
      [dstSite]: [],
      local: [],
    };

    const mockDriver = (siteName: string): BotContainerDriver => ({
      async status() {
        driverCalls[siteName]?.push("status");
        return { botKey, state: "missing", gatewayPort: 18642 } as BotContainerStatus;
      },
      async list() { return []; },
      async templateDrift() { return { drifted: false, fields: [] }; },
      async create() { driverCalls[siteName]?.push("create"); },
      async recreate() { driverCalls[siteName]?.push("recreate"); },
      async writeProfile() { driverCalls[siteName]?.push("writeProfile"); },
      async start() { driverCalls[siteName]?.push("start"); },
      async restart() { driverCalls[siteName]?.push("restart"); },
      async stop() { driverCalls[siteName]?.push("stop"); },
    });

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
        siteRestoreCalls.push(`${siteName}:${key}:${Buffer.concat(chunks).toString()}`);
      },
      async quarantine(key) {
        siteQuarantineCalls.push(`${siteName}:${key}`);
      },
    });

    const service = new FleetMoveService({
      async getMove(id) {
        return moveRecords.get(id) ?? null;
      },
      async getLatestMoveForBot(_companyId, key) {
        for (const m of moveRecords.values()) {
          if (m.botKey === key) return m;
        }
        return null;
      },
      async createMove(params) {
        const record: FleetMoveRecord = {
          id: `move-${Date.now()}`,
          companyId: params.companyId,
          botKey: params.botKey,
          srcSite: params.srcSite,
          dstSite: params.dstSite,
          phase: "init",
          phaseLog: [{ phase: "init", at: new Date().toISOString(), details: "Move created" }],
          startedAt: new Date(),
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
        return site === "myr-vm1" ? "http://site-a.example.test:9100" : "http://core.example.test:9100";
      },

      async getAgentCard(key) {
        return card.adapterConfig.container.botKey === key ? card : null;
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
        async enter(k) { maintenanceCalls.push(`enter:${k}`); },
        async exit(k) { maintenanceCalls.push(`exit:${k}`); },
      },
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
    };
  }

  it("completes full migration state machine with zero data loss and visible phase log", async () => {
    const harness = createTestHarness({ srcSite: "myr-vm1", dstSite: "vm-core", botKey: "work-qa" });

    const result = await harness.service.startMove({
      companyId: "company-1",
      botKey: "work-qa",
      dstSite: "vm-core",
    });

    expect(result.phase).toBe("done");
    expect(result.completedAt).toBeDefined();

    // Verify all phases occurred in order in phaseLog
    const phases = result.phaseLog.map((l) => l.phase);
    expect(phases).toEqual([
      "init",
      "stop",
      "snapshot",
      "restore",
      "host",
      "reconcile",
      "apiBaseUrl",
      "done",
    ]);

    // Verify maintenance window
    expect(harness.maintenanceCalls).toEqual(["enter:work-qa", "exit:work-qa"]);

    // Verify driver calls on source site
    expect(harness.driverCalls["myr-vm1"]).toContain("stop");

    // Verify snapshot from source site
    expect(harness.siteSnapshotCalls).toEqual(["myr-vm1:work-qa"]);

    // Verify restore into target site with identical payload
    expect(harness.siteRestoreCalls).toEqual(["vm-core:work-qa:tar.zst mock data payload"]);

    // Verify target driver reconciled the bot
    expect(harness.driverCalls["vm-core"]).toContain("create");
    expect(harness.driverCalls["vm-core"]).toContain("writeProfile");
    expect(harness.driverCalls["vm-core"]).toContain("start");

    // Verify source datadir was quarantined
    expect(harness.siteQuarantineCalls).toEqual(["myr-vm1:work-qa"]);

    // Verify agent card was updated
    const finalCard = harness.getCard();
    expect(finalCard.adapterConfig.container.host).toBe("vm-core");
    expect(finalCard.adapterConfig.apiBaseUrl).toBe("http://core.example.test:18642");
  });

  it("supports roundtrip move work-qa myr-vm1 -> vm-core -> back to myr-vm1", async () => {
    const harness = createTestHarness({ srcSite: "myr-vm1", dstSite: "vm-core", botKey: "work-qa" });

    // Step 1: myr-vm1 -> vm-core
    const move1 = await harness.service.startMove({
      companyId: "company-1",
      botKey: "work-qa",
      dstSite: "vm-core",
    });
    expect(move1.phase).toBe("done");
    expect(harness.getCard().adapterConfig.container.host).toBe("vm-core");

    // Step 2: vm-core -> myr-vm1
    const move2 = await harness.service.startMove({
      companyId: "company-1",
      botKey: "work-qa",
      dstSite: "myr-vm1",
    });
    expect(move2.phase).toBe("done");
    expect(harness.getCard().adapterConfig.container.host).toBe("myr-vm1");
    expect(harness.getCard().adapterConfig.apiBaseUrl).toBe("http://site-a.example.test:18642");
  });

  it("fails gracefully and records error in phase log when a phase throws", async () => {
    const harness = createTestHarness();
    vi.spyOn(harness.service["deps"], "getSiteAgentClient").mockRejectedValueOnce(
      new Error("connection timeout to site agent"),
    );

    const result = await harness.service.startMove({
      companyId: "company-1",
      botKey: "work-qa",
      dstSite: "vm-core",
    });

    expect(result.phase).toBe("failed");
    expect(result.error).toContain("connection timeout to site agent");
    expect(result.phaseLog.some((l) => l.phase === "failed")).toBe(true);
  });
});
