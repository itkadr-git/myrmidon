// myrmidon(1.6.2-FORAGING-IDLE-GATE): the "только в простое" rule of the pass.
//
// Two halves are pinned here: the pure plan (which roles a pass may read, and
// why it was held back) and the pass itself — the rule is read on EVERY pass,
// so the screen changes the next pass without a restart, and a skipped pass is
// recorded with its reason. The store, the reader and the probe are fakes: this
// pins the rule, not the vendor.

import { describe, expect, it, vi } from "vitest";
import type { ForagingPassRecord } from "@paperclipai/shared";
import { planIdleGate } from "./agent-idle-check.js";
import { readForagingIdleOnlyEnv } from "./settings.js";
import { createForagingService, type ForagingServiceDeps } from "./service.js";
import type { ForagingSourceRow, ForagingStore } from "./store.js";

const source = (overrides: Partial<ForagingSourceRow> = {}): ForagingSourceRow => ({
  id: "source-1",
  companyId: "company-a",
  role: "engineer",
  url: "https://example.com/changelog",
  kind: "url",
  enabled: true,
  lastSnapshot: ["a"],
  lastSnapshotAt: new Date("2026-10-02T10:00:00.000Z"),
  lastCheckedAt: new Date("2026-10-02T10:00:00.000Z"),
  lastError: null,
  ...overrides,
});

function fakeStore(sources: ForagingSourceRow[]): ForagingStore {
  return {
    listSources: vi.fn(async () => sources),
    enabledSources: vi.fn(async () => sources),
    upsertSource: vi.fn(async () => sources[0]),
    deleteSource: vi.fn(async () => true),
    saveSnapshot: vi.fn(async () => {}),
    saveRead: vi.fn(async () => {}),
    insertFinding: vi.fn(),
    listFindings: vi.fn(async () => []),
    listUnverifiedFindings: vi.fn(async () => []),
    markFindingCandidate: vi.fn(async () => {}),
    monthFindingCount: vi.fn(async () => 0),
    listCompanyIds: vi.fn(async () => ["company-a"]),
  } as unknown as ForagingStore;
}

/** A pass whose rule and busy roles the test drives directly. */
function passWith(options: {
  sources?: ForagingSourceRow[];
  isIdleOnly?: () => Promise<boolean>;
  busyRoles?: string[];
  getBusyRoles?: () => string[];
  idleOnly?: boolean;
}) {
  const recorded: ForagingPassRecord[] = [];
  const read = vi.fn(async () => ({ text: "a\nb", bytes: 1024 }));
  const busyRoles = vi.fn(async () => options.getBusyRoles?.() ?? options.busyRoles ?? []);
  const isIdleOnly = vi.fn(options.isIdleOnly ?? (async () => options.idleOnly ?? false));
  const service = createForagingService({
    store: fakeStore(options.sources ?? [source()]),
    reader: { read },
    candidatePort: { available: false, createFindingCandidate: async () => null },
    settings: { budget: { maxCostCents: 0, enabled: false } },
    idleGate: {
      isIdleOnly,
      probe: { busyRoles },
      recordPass: async (_companyId, record) => {
        recorded.push(record);
      },
    },
    now: () => new Date("2026-10-04T09:30:00.000Z"),
    log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as ForagingServiceDeps["log"],
  });
  return { service, recorded, read, busyRoles, isIdleOnly };
}

describe("myrmidon(1.6.2-FORAGING-IDLE-GATE) planIdleGate", () => {
  it("reads every role while the rule is off", () => {
    const plan = planIdleGate({ idleOnly: false, roles: ["engineer", "smm"], busyRoles: ["engineer"] });
    expect(plan).toEqual({ readableRoles: ["engineer", "smm"], blockedRoles: [], skipReason: null });
  });

  it("reads every role when none has work in flight", () => {
    const plan = planIdleGate({ idleOnly: true, roles: ["engineer", "smm"], busyRoles: [] });
    expect(plan).toEqual({ readableRoles: ["engineer", "smm"], blockedRoles: [], skipReason: null });
  });

  it("holds back only the roles with work and still runs the pass", () => {
    const plan = planIdleGate({ idleOnly: true, roles: ["engineer", "smm"], busyRoles: ["engineer"] });
    expect(plan.readableRoles).toEqual(["smm"]);
    expect(plan.blockedRoles).toEqual(["engineer"]);
    expect(plan.skipReason).toBeNull();
  });

  it("reports the reason when every role has work in flight", () => {
    const plan = planIdleGate({ idleOnly: true, roles: ["engineer"], busyRoles: ["engineer"] });
    expect(plan.readableRoles).toEqual([]);
    expect(plan.blockedRoles).toEqual(["engineer"]);
    expect(plan.skipReason).toBe("agents_busy_for_role");
  });

  it("deduplicates roles and never blocks on a role with no source", () => {
    const plan = planIdleGate({
      idleOnly: true,
      roles: ["engineer", "engineer", "smm"],
      busyRoles: ["designer"],
    });
    expect(plan.readableRoles).toEqual(["engineer", "smm"]);
    expect(plan.blockedRoles).toEqual([]);
    expect(plan.skipReason).toBeNull();
  });

  it("has nothing to plan without a registry", () => {
    const plan = planIdleGate({ idleOnly: true, roles: [], busyRoles: ["engineer"] });
    expect(plan).toEqual({ readableRoles: [], blockedRoles: [], skipReason: null });
  });
});

describe("myrmidon(1.6.2-FORAGING-IDLE-GATE) the environment force", () => {
  it("accepts the words that force the rule on", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(readForagingIdleOnlyEnv(raw)).toBe(true);
    }
  });

  it("accepts the words that force the rule off", () => {
    for (const raw of ["0", "false", "No", "off"]) {
      expect(readForagingIdleOnlyEnv(raw)).toBe(false);
    }
  });

  it("treats an empty or unknown value as not set, never as a flip", () => {
    for (const raw of [undefined, "", "   ", "maybe", "2"]) {
      expect(readForagingIdleOnlyEnv(raw)).toBeNull();
    }
  });
});

describe("myrmidon(1.6.2-FORAGING-IDLE-GATE) the pass", () => {
  it("holds the whole pass back when the only role has work, and records why", async () => {
    const { service, recorded, read } = passWith({ idleOnly: true, busyRoles: ["engineer"] });
    const result = await service.runPass("company-a");

    expect(result.skipReason).toBe("agents_busy_for_role");
    expect(result.skippedRoles).toEqual(["engineer"]);
    expect(result.sourcesRead).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      skipReason: "agents_busy_for_role",
      skippedRoles: ["engineer"],
      sourcesRead: 0,
    });
  });

  it("reads the idle roles and records the roles it skipped", async () => {
    const { service, recorded } = passWith({
      sources: [source(), source({ id: "source-2", role: "smm", url: "https://example.com/news" })],
      idleOnly: true,
      busyRoles: ["engineer"],
    });
    const result = await service.runPass("company-a");

    expect(result.skipReason).toBeNull();
    expect(result.skippedRoles).toEqual(["engineer"]);
    expect(result.sourcesRead).toBe(1);
    expect(recorded[0]).toMatchObject({ skipReason: null, skippedRoles: ["engineer"], sourcesRead: 1 });
  });

  it("ignores the load entirely while the rule is off", async () => {
    const { service, busyRoles } = passWith({ idleOnly: false, busyRoles: ["engineer"] });
    const result = await service.runPass("company-a");

    expect(busyRoles).not.toHaveBeenCalled();
    expect(result.skipReason).toBeNull();
    expect(result.skippedRoles).toEqual([]);
    expect(result.sourcesRead).toBe(1);
  });

  it("reads the rule on every pass, so a change lands in the next one without a restart", async () => {
    // The screen stores the value and the pass re-reads it; nothing is cached
    // between the two passes of this test — that is the whole point.
    let idleOnly = false;
    let busy: string[] = [];
    const { service } = passWith({ isIdleOnly: async () => idleOnly, getBusyRoles: () => busy });

    const before = await service.runPass("company-a");
    expect(before.skipReason).toBeNull();
    expect(before.sourcesRead).toBe(1);

    // The switch was flipped and the role picked up work between the passes.
    idleOnly = true;
    busy = ["engineer"];
    const after = await service.runPass("company-a");
    expect(after.skipReason).toBe("agents_busy_for_role");
    expect(after.sourcesRead).toBe(0);
  });

  it("runs the pass as before when the probe fails", async () => {
    const recorded: ForagingPassRecord[] = [];
    const service = createForagingService({
      store: fakeStore([source()]),
      reader: { read: async () => ({ text: "a\nb", bytes: 1024 }) },
      candidatePort: { available: false, createFindingCandidate: async () => null },
      settings: { budget: { maxCostCents: 0, enabled: false } },
      idleGate: {
        isIdleOnly: async () => true,
        probe: {
          busyRoles: async () => {
            throw new Error("probe unavailable");
          },
        },
        recordPass: async (_companyId, record) => {
          recorded.push(record);
        },
      },
      log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as ForagingServiceDeps["log"],
    });

    const result = await service.runPass("company-a");
    expect(result.skipReason).toBeNull();
    expect(result.sourcesRead).toBe(1);
    expect(recorded).toHaveLength(1);
  });
});