// server/src/myrmidon/bot-containers/fleet-move-replica.myrmidon.test.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): a move whose source site is lost restores the last replica and
// never contacts the source; and the claim of a bot's single unfinished move is atomic.

import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  FleetMoveClaimConflict,
  FleetMoveError,
  FleetMoveService,
  type FleetMoveRecord,
  type MoveSource,
  type SiteAgentClient,
} from "./fleet-move-service.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";

function harness(opts: { replica?: boolean; restoreError?: Error } = {}) {
  const botKey = "work-qa";
  const moves = new Map<string, FleetMoveRecord>();
  const calls: string[] = [];
  let card = {
    agentId: "agent-1",
    adapterConfig: { container: { enabled: true, host: "myr-vm1" }, apiBaseUrl: "http://old" } as Record<string, any>,
  };
  const states = new Map<string, "running" | "stopped" | "missing">([["myr-vm1", "running"]]);

  const driver = (site: string): BotContainerDriver => ({
    async status() {
      const state = states.get(site) ?? "missing";
      return { botKey, state, ...(state === "missing" ? {} : { gatewayPort: 8642 }) } as BotContainerStatus;
    },
    async list() { return []; },
    async templateDrift() { return { drifted: false, fields: [] }; },
    async create() { calls.push(`${site}:create`); states.set(site, "stopped"); },
    async recreate() { calls.push(`${site}:recreate`); },
    async writeProfile() { calls.push(`${site}:writeProfile`); },
    async start() { calls.push(`${site}:start`); states.set(site, "running"); },
    async restart() { calls.push(`${site}:restart`); },
    async stop() { calls.push(`${site}:stop`); states.set(site, "stopped"); },
  });
  const agent = (site: string): SiteAgentClient => ({
    async snapshot() { calls.push(`${site}:snapshot`); return Readable.from([Buffer.from("live")]); },
    async restore(_key, stream) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      if (opts.restoreError) throw opts.restoreError;
      calls.push(`${site}:restore:${Buffer.concat(chunks).toString()}`);
    },
    async quarantine() { calls.push(`${site}:quarantine`); },
  });

  const service = new FleetMoveService({
    async getMove(id) { return moves.get(id) ?? null; },
    async getLatestMoveForBot(_c, key) {
      return [...moves.values()].filter((m) => m.botKey === key).at(-1) ?? null;
    },
    async createMove(p) {
      // The same contract as the store's unique index: one unfinished move per bot.
      const open = [...moves.values()].find((m) => m.botKey === p.botKey && m.phase !== "done" && m.phase !== "failed");
      if (open) throw new FleetMoveClaimConflict(p.botKey);
      const record: FleetMoveRecord = {
        id: `move-${moves.size + 1}`, companyId: p.companyId, botKey: p.botKey, srcSite: p.srcSite, dstSite: p.dstSite,
        source: (p.source ?? "live") as MoveSource, phase: "init", phaseLog: [], startedAt: new Date(),
      };
      moves.set(record.id, record);
      return record;
    },
    async updateMove(id, u) {
      const next = { ...moves.get(id)!, phase: u.phase, error: u.error ?? moves.get(id)!.error, completedAt: u.completedAt ?? moves.get(id)!.completedAt,
        phaseLog: [...moves.get(id)!.phaseLog, { phase: u.phase, at: new Date().toISOString(), details: u.details, error: u.error ?? undefined }] };
      moves.set(id, next);
      return next;
    },
    async openReplica(site) {
      if (!opts.replica) return null;
      calls.push(`replica:open:${site}`);
      return { stream: Readable.from([Buffer.from("replica")]), capturedAt: new Date("2026-10-23T07:45:00.000Z") };
    },
    async getDriverForSite(site) { return driver(site); },
    async getSiteAgentClient(site) { return agent(site); },
    async getSiteUrl() { return "http://site:9100"; },
    async getAgentCard(key) { return key === botKey ? card : null; },
    async updateAgentCard(_id, next) { card = { ...card, adapterConfig: next as any }; },
    async getBotSpec(key) { return { botKey: key, image: "x@sha256:1", memoryMb: 1, cpus: 1, pidsLimit: 1, network: "n" }; },
    async getCompiledProfile(key) { return { botKey: key, files: [], restartHash: "r", filesHash: "f" }; },
    maintenance: {
      async enter() { calls.push("window:enter"); },
      async exit() { calls.push("window:exit"); },
    },
  });
  return { service, calls, moves, getCard: () => card };
}

const MOVE = { companyId: "c1", botKey: "work-qa", dstSite: "local" };

describe("replica-sourced fleet move", () => {
  it("restores the replica on the destination and never contacts the lost source", async () => {
    const h = harness({ replica: true });
    const move = await h.service.startMove({ ...MOVE, source: "replica" });

    expect(move.phase).toBe("done");
    expect(move.source).toBe("replica");
    expect(h.calls.filter((c) => c.startsWith("myr-vm1:"))).toEqual([]);
    expect(h.calls).toContain("local:restore:replica");
    expect(h.calls.indexOf("window:enter")).toBeLessThan(h.calls.indexOf("local:restore:replica"));
    expect(h.calls.at(-1)).toBe("window:exit");
    expect(h.getCard().adapterConfig.container.host).toBeUndefined();
    const log = move.phaseLog.map((e) => e.details ?? "").join("\n");
    expect(log).toContain("taken at 2026-10-23T07:45:00.000Z");
    expect(log).toContain("not contacted");
  });

  it("fails without a replica, leaves the card on the source and does not try to start the source", async () => {
    const h = harness({ replica: false });
    const move = await h.service.startMove({ ...MOVE, source: "replica" });

    expect(move.phase).toBe("failed");
    expect(move.error).toContain("No replica");
    expect(h.getCard().adapterConfig.container.host).toBe("myr-vm1");
    expect(h.calls.filter((c) => c.startsWith("myr-vm1:"))).toEqual([]);
    expect(h.calls.at(-1)).toBe("window:exit");
  });

  it("a restore that breaks off rolls back without starting the lost source", async () => {
    const h = harness({ replica: true, restoreError: new Error("manifest mismatch") });
    const move = await h.service.startMove({ ...MOVE, source: "replica" });

    expect(move.phase).toBe("failed");
    expect(move.error).toContain("manifest mismatch");
    expect(h.getCard().adapterConfig.container.host).toBe("myr-vm1");
    expect(h.calls).not.toContain("myr-vm1:start");
  });

  it("a live move still stops and snapshots the source (unchanged)", async () => {
    const h = harness({ replica: true });
    const move = await h.service.startMove({ ...MOVE });
    expect(move.phase).toBe("done");
    expect(move.source).toBe("live");
    expect(h.calls).toContain("myr-vm1:stop");
    expect(h.calls).toContain("myr-vm1:snapshot");
    expect(h.calls).toContain("myr-vm1:quarantine");
  });
});

describe("atomic claim of a bot's move", () => {
  it("two simultaneous starts for one bot: one move runs, the other is a conflict, nothing is assigned twice", async () => {
    // No in-process lock here: this is the cross-process case, where only the store's claim stands between the two.
    const h = harness({ replica: true });
    const results = await Promise.allSettled([
      h.service.startMove({ ...MOVE, source: "replica" }),
      h.service.startMove({ ...MOVE, source: "replica" }),
    ]);

    const done = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(done).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(FleetMoveError);
    expect((rejected[0]!.reason as FleetMoveError).kind).toBe("conflict");
    expect(h.moves.size).toBe(1);
    expect(h.calls.filter((c) => c === "local:start")).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith("local:restore"))).toHaveLength(1);
  });
});
