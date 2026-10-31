// myrmidon(1.6.6 REMOTE-SITES-T5): the site-scheduler lane — what a tick does with the verdict.

import { afterEach, describe, expect, it, vi } from "vitest";
import { startSiteSchedulerLane, type ScheduledAgentCard, type SiteSchedulerLaneDeps } from "./site-scheduler-lane.js";
import type { FleetMoveRecord } from "./fleet-move-service.js";
import type { FleetSiteInfo } from "./site-scheduler.js";

const COMPANY = "company-1";
const BOT_WORK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOT_OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sites: FleetSiteInfo[] = [
  { name: "myr-vm1", status: "active", capacity: { maxCpus: 4, maxMemoryMb: 4096, maxBots: 3 } },
  { name: "vm-b", status: "active", capacity: { maxCpus: 64, maxMemoryMb: 262144 } },
];

function card(id: string, container: Record<string, unknown> = {}): ScheduledAgentCard {
  return {
    id,
    companyId: COMPANY,
    adapterConfig: { container: { enabled: true, memoryMb: 1024, cpus: 1, pidsLimit: 256, ...container } },
  };
}

function record(overrides: Partial<FleetMoveRecord>): FleetMoveRecord {
  return {
    id: "m1",
    companyId: COMPANY,
    botKey: BOT_WORK,
    srcSite: "local",
    dstSite: "myr-vm1",
    phase: "done",
    phaseLog: [],
    startedAt: new Date("2026-10-21T08:00:00.000Z"),
    ...overrides,
  };
}

const lanes: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const l of lanes.splice(0)) l.stop();
});

function lane(cards: ScheduledAgentCard[], overrides: Partial<SiteSchedulerLaneDeps> = {}) {
  const mocks = {
    listAgents: vi.fn(async () => cards),
    listSites: vi.fn(async () => sites),
    listAffinityRules: vi.fn(async () => [{ scope: "agent" as const, targetId: BOT_WORK, siteName: "myr-vm1", weight: 100 }]),
    requestMove: vi.fn(async (p: { companyId: string; botKey: string; dstSite: string }) =>
      record({ botKey: p.botKey, dstSite: p.dstSite, phase: "done" }),
    ),
    getLatestMove: vi.fn(async (): Promise<FleetMoveRecord | null> => null),
    saveContainerConfig: vi.fn(async (_agentId: string, _container: Record<string, unknown>): Promise<void> => undefined),
  };
  const started = startSiteSchedulerLane({ ...mocks, intervalMs: 3_600_000, ...overrides });
  lanes.push(started);
  return { ...started, deps: mocks };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("site-scheduler lane", () => {
  it("moves a bot whose affinity site differs from where it is — by a move, not by rewriting host", async () => {
    const { tick, deps } = lane([card(BOT_WORK), card(BOT_OTHER)]);
    await tick();
    await settle();
    expect(deps.requestMove).toHaveBeenCalledTimes(1);
    expect(deps.requestMove).toHaveBeenCalledWith({ companyId: COMPANY, botKey: BOT_WORK, dstSite: "myr-vm1" });
    expect(deps.saveContainerConfig).not.toHaveBeenCalled();
  });

  it("does nothing for a bot already on its affinity site, for capacity-only verdicts and for pinned bots", async () => {
    const { tick, deps } = lane([
      card(BOT_WORK, { host: "myr-vm1" }),
      card(BOT_OTHER), // no affinity: capacity would pick a site, but a running bot is not shuffled
    ]);
    await tick();
    await settle();
    expect(deps.requestMove).not.toHaveBeenCalled();

    const pinned = lane([card(BOT_WORK, { hostPinned: true })]);
    await pinned.tick();
    await settle();
    expect(pinned.deps.requestMove).not.toHaveBeenCalled();
  });

  it("marks a bot pending (and keeps it where it is) when the affinity site has no room", async () => {
    const full: FleetSiteInfo[] = [{ name: "myr-vm1", status: "active", capacity: { maxCpus: 4, maxMemoryMb: 512 } }];
    const { tick, deps } = lane([card(BOT_WORK)], { listSites: vi.fn(async () => full) });
    const result = await tick();
    await settle();
    expect(result.pendingPlacementQueue).toEqual([BOT_WORK]);
    expect(deps.requestMove).not.toHaveBeenCalled();
    expect(deps.saveContainerConfig).toHaveBeenCalledTimes(1);
    const [, container] = deps.saveContainerConfig.mock.calls[0]!;
    expect(container.placementStatus).toBe("pending_placement");
    expect(container.host).toBeUndefined();
  });

  it("clears the pending mark once the bot sits where the scheduler wants it", async () => {
    const { tick, deps } = lane([card(BOT_WORK, { host: "myr-vm1", placementStatus: "pending_placement", placementError: "x" })]);
    await tick();
    const [, container] = deps.saveContainerConfig.mock.calls[0]!;
    expect(container.placementStatus).toBeUndefined();
    expect(container.placementError).toBeUndefined();
  });

  it("runs one move at a time and does not start a bot's move twice", async () => {
    let finish: (r: FleetMoveRecord) => void = () => undefined;
    const requestMove = vi.fn(
      () =>
        new Promise<FleetMoveRecord>((resolve) => {
          finish = resolve;
        }),
    );
    const { tick } = lane([card(BOT_WORK), card(BOT_OTHER)], {
      requestMove,
      listAffinityRules: vi.fn(async () => [
        { scope: "agent" as const, targetId: BOT_WORK, siteName: "myr-vm1", weight: 100 },
        { scope: "agent" as const, targetId: BOT_OTHER, siteName: "myr-vm1", weight: 100 },
      ]),
    });
    await tick();
    await tick();
    expect(requestMove).toHaveBeenCalledTimes(1);
    finish(record({ phase: "done" }));
    await settle();
  });

  it("leaves a bot alone for a while after a failed move, and resumes an unfinished one", async () => {
    const failedAt = new Date("2026-10-21T08:00:00.000Z");
    const failed = record({ phase: "failed", phaseLog: [{ phase: "failed", at: failedAt.toISOString() }] });
    const backoff = lane([card(BOT_WORK)], {
      getLatestMove: vi.fn(async () => failed),
      now: () => failedAt.getTime() + 60_000,
    });
    await backoff.tick();
    await settle();
    expect(backoff.deps.requestMove).not.toHaveBeenCalled();

    const later = lane([card(BOT_WORK)], {
      getLatestMove: vi.fn(async () => failed),
      now: () => failedAt.getTime() + 16 * 60_000,
    });
    await later.tick();
    await settle();
    expect(later.deps.requestMove).toHaveBeenCalledTimes(1);

    const unfinished = lane([card(BOT_WORK)], {
      getLatestMove: vi.fn(async () => record({ phase: "restore", dstSite: "vm-b" })),
    });
    await unfinished.tick();
    await settle();
    expect(unfinished.deps.requestMove).toHaveBeenCalledWith({ companyId: COMPANY, botKey: BOT_WORK, dstSite: "vm-b" });
  });

  it("ignores cards whose container is off or whose host is invalid", async () => {
    const { tick, deps } = lane([card(BOT_WORK, { enabled: false }), card(BOT_OTHER, { host: "local" })]);
    const result = await tick();
    expect(result.decisions.size).toBe(0);
    expect(deps.requestMove).not.toHaveBeenCalled();
  });
});
