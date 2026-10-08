// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass journal — the service
// half (read/record against the general row) and the pass half (every exit of
// a pass lands in the history, with the roles it skipped and why). The whole
// point of the ticket: "видно, почему проход был пропущен".
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { FORAGING_PASS_JOURNAL_KEY } from "@paperclipai/shared";
import { foragingPassJournalService, type ForagingPassJournalServiceDeps } from "./pass-journal.js";
import { createForagingService, type ForagingIdleCheck } from "./service.js";
import type { ForagingReader } from "./service.js";
import type { ForagingSourceRow, ForagingStore } from "./store.js";

function fakeGeneralStore(start: Record<string, unknown> = {}) {
  const state = { general: { ...start } as Record<string, unknown>, updates: [] as Array<Record<string, unknown>> };
  const deps: ForagingPassJournalServiceDeps = {
    getGeneral: async () => state.general,
    updateGeneral: async (patch) => {
      state.updates.push(patch as Record<string, unknown>);
      state.general = { ...state.general, ...(patch as Record<string, unknown>) };
      return state.general;
    },
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  };
  return { deps, state };
}

const summary = {
  sourcesRead: 3,
  findings: 1,
  candidates: 0,
  errors: 0,
  stoppedByBudget: false,
  skippedReason: "no_idle_agent" as const,
  skipped: [{ role: "engineer", reason: "no_idle_agent" as const }],
};

// 1.6.1: the resolved settings the pass reads (env-only view, no limits).
const NO_LIMITS_SETTINGS = {
  enabled: true,
  intervalSec: 3600,
  minHostIntervalSec: 60,
  passBudgetCents: null,
  dailyBudgetCents: null,
  monthlyBudgetCents: null,
  roleBudgetCents: null,
  agentBudgetCents: null,
  enforcement: "hard",
  autoOffCostPerTaskCents: null,
} as const;

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half) pass journal service", () => {
  it("records a pass under the general key and reads it back for that company", async () => {
    const { deps, state } = fakeGeneralStore();
    const service = foragingPassJournalService(null as never, deps);
    await service.record("company-a", summary);
    const stored = state.general[FORAGING_PASS_JOURNAL_KEY] as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      at: "2026-10-04T12:00:00.000Z",
      companyId: "company-a",
      sourcesRead: 3,
      skippedReason: "no_idle_agent",
      skipped: [{ role: "engineer", reason: "no_idle_agent" }],
    });
    expect(state.updates).toHaveLength(1);
    const read = await service.read("company-a");
    expect(read).toHaveLength(1);
    expect(read[0]?.skipped[0]).toEqual({ role: "engineer", reason: "no_idle_agent" });
    // Another company's history stays empty.
    expect(await service.read("company-b")).toEqual([]);
        });

  it("serializes the read-modify-write, so two passes recording at once both land", async () => {
    // Two journal services over the same row, the way the wiring has them
    // (the sweep and the routes). Without the write chain both read the same
    // empty journal and the slower write drops the other pass.
    const { deps, state } = fakeGeneralStore();
    const slowDeps: ForagingPassJournalServiceDeps = {
      ...deps,
      getGeneral: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return state.general;
      },
    };
    const first = foragingPassJournalService(null as never, slowDeps);
    const second = foragingPassJournalService(null as never, { ...slowDeps });

    await Promise.all([first.record("company-a", summary), second.record("company-a", summary)]);

    expect(state.general[FORAGING_PASS_JOURNAL_KEY]).toHaveLength(2);
  });

        it("keeps a pass that read nothing, so the history shows the skip", async () => {
    const { deps } = fakeGeneralStore();
    const service = foragingPassJournalService(null as never, deps);
    await service.record("company-a", {
      sourcesRead: 0,
      findings: 0,
      candidates: 0,
      errors: 0,
      stoppedByBudget: false,
      skippedReason: "queue_not_empty",
      skipped: [{ role: "engineer", reason: "queue_not_empty" }],
    });
    const read = await service.read("company-a");
    expect(read[0]).toMatchObject({ sourcesRead: 0, skippedReason: "queue_not_empty" });
  });

  it("answers an empty history when the stored row cannot be read", async () => {
    const service = foragingPassJournalService(null as never, {
      getGeneral: async () => {
        throw new Error("db down");
      },
      updateGeneral: async () => undefined,
    });
    expect(await service.read("company-a")).toEqual([]);
  });

  it("does not throw when the journal write fails (a pass already happened)", async () => {
    const service = foragingPassJournalService(null as never, {
      getGeneral: async () => ({}),
      updateGeneral: async () => {
        throw new Error("db down");
      },
    });
    await expect(service.record("company-a", summary)).resolves.toBeUndefined();
  });
});

/** A store with the two methods a pass touches. */
function passStore(rows: Array<{ id: string; role: string; snapshot?: string[] | null }>): {
  store: ForagingStore;
  inserted: string[];
} {
  const sources: ForagingSourceRow[] = rows.map((row) => ({
    id: row.id,
    companyId: "company-a",
    role: row.role,
    url: `https://example.com/${row.id}`,
    kind: "url",
    enabled: true,
    lastSnapshot: row.snapshot === undefined ? ["one"] : row.snapshot,
    lastSnapshotAt: null,
    lastCheckedAt: null,
    lastError: null,
  }));
  const inserted: string[] = [];
  const store = {
    async enabledSources() {
      return sources;
    },
    async saveSnapshot() {},
    async saveRead() {},
    async insertFinding(input: { summary: string }) {
      inserted.push(input.summary);
      return { ...input, id: `finding-${inserted.length}` };
    },
  } as unknown as ForagingStore;
  return { store, inserted };
}

function scriptedIdleCheck(reasons: Record<string, "queue_not_empty" | "no_idle_agent" | null>): ForagingIdleCheck {
  return {
    async roleIdleReason(_companyId, role) {
      return reasons[role] ?? null;
    },
  };
}

const reader: ForagingReader = {
  async read(source) {
    const body = source.url.endsWith("/s2") ? "one\ntwo\n" : "one\n";
    return { text: body, bytes: body.length };
  },
};

const silentLog: Pick<Logger, "info" | "warn" | "error"> = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half) the pass records itself", () => {
  it("records the pass with every role it skipped and its reason", async () => {
    const record = vi.fn(async () => {});
    const { store } = passStore([
      { id: "s1", role: "engineer" },
      { id: "s2", role: "researcher" },
      { id: "s3", role: "engineer" },
    ]);
    const service = createForagingService({
      store,
      reader,
      candidatePort: { available: false, async createFindingCandidate() { return null; } },
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
      db: {} as never,
      log: silentLog,
      journal: { record },
      idleCheck: scriptedIdleCheck({ engineer: "queue_not_empty", researcher: "no_idle_agent" }),
    });

    const result = await service.runPass("company-a");

    expect(result.sourcesRead).toBe(0);
    expect(record).toHaveBeenCalledTimes(1);
    const [, recorded] = record.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(recorded).toMatchObject({
      sourcesRead: 0,
      findings: 0,
      stoppedByBudget: false,
      skipped: [
        { role: "engineer", reason: "queue_not_empty" },
        { role: "researcher", reason: "no_idle_agent" },
      ],
    });
  });

  it("records a pass that read a source and skipped none", async () => {
    const record = vi.fn(async () => {});
    const { store } = passStore([{ id: "s2", role: "engineer", snapshot: ["one"] }]);
    const service = createForagingService({
      store,
      reader,
      candidatePort: { available: false, async createFindingCandidate() { return null; } },
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
      db: {} as never,
      log: silentLog,
      journal: { record },
      idleCheck: scriptedIdleCheck({}),
    });

    const result = await service.runPass("company-a");

    expect(result.sourcesRead).toBe(1);
    expect(record).toHaveBeenCalledTimes(1);
    const [, recorded] = record.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(recorded).toMatchObject({ sourcesRead: 1, findings: 1, skippedReason: null, skipped: [] });
  });

  it("records the pass even when the sources cannot be listed", async () => {
    const record = vi.fn(async () => {});
    const store = {
      async enabledSources() {
        throw new Error("db down");
      },
    } as unknown as ForagingStore;
    const service = createForagingService({
      store,
      reader,
      candidatePort: { available: false, async createFindingCandidate() { return null; } },
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
      db: {} as never,
      log: silentLog,
      journal: { record },
    });

    await service.runPass("company-a");

    expect(record).toHaveBeenCalledTimes(1);
    const [, recorded] = record.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(recorded).toMatchObject({ sourcesRead: 0, errors: 0, skipped: [] });
  });

  it("a journal failure does not fail the pass", async () => {
    const record = vi.fn(async () => {
      throw new Error("db down");
    });
    const { store } = passStore([{ id: "s2", role: "engineer" }]);
    const service = createForagingService({
      store,
      reader,
      candidatePort: { available: false, async createFindingCandidate() { return null; } },
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
      db: {} as never,
      log: silentLog,
      journal: { record },
      idleCheck: scriptedIdleCheck({}),
    });

    const result = await service.runPass("company-a");

    expect(result.sourcesRead).toBe(1);
    expect(record).toHaveBeenCalledTimes(1);
  });
});