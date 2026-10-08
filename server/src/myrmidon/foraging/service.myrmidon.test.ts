// myrmidon(1.6.3-FORAGING-IDLE-GATE): the idle gate of the sweep pass —
// the three acceptance rules of the ticket live here:
//   1. a role with an unassigned queued task is skipped (queue_not_empty);
//   2. a role with an empty queue and a free agent is read;
//   3. the toggle off restores the old behaviour WITHOUT recreating the
//      service (the pass re-reads the setting every pass).
// Plus: a busy role does not stop the sweep (other roles are still read),
// and no idle agent skips the role's sources (no_idle_agent).
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { ForagingCandidateInput, ForagingCandidatePort } from "./domain.js";
import { createForagingService, type ForagingIdleCheck } from "./service.js";
import type { ForagingReader } from "./service.js";
import type {
  ForagingFindingInsert,
  ForagingFindingRow,
  ForagingSourceInput,
  ForagingSourceRow,
  ForagingStore,
} from "./store.js";

interface MemoryStore extends ForagingStore {
  sources: Map<string, ForagingSourceRow>;
  findings: ForagingFindingRow[];
}

function createMemoryStore(rows: Array<Partial<ForagingSourceRow> & { id: string; role: string; url: string }>): MemoryStore {
  const sources = new Map<string, ForagingSourceRow>();
  for (const row of rows) {
    sources.set(row.id, {
      id: row.id,
      companyId: row.companyId ?? "company-a",
      role: row.role,
      url: row.url,
      kind: row.kind ?? "url",
      enabled: row.enabled ?? true,
      lastSnapshot: row.lastSnapshot ?? null,
      lastSnapshotAt: row.lastSnapshotAt ?? null,
      lastCheckedAt: row.lastCheckedAt ?? null,
      lastError: row.lastError ?? null,
    });
  }
  const findings: ForagingFindingRow[] = [];
  const store: MemoryStore = {
    sources,
    findings,
    async listSources() {
      return [...sources.values()];
    },
    async enabledSources() {
      return [...sources.values()].filter((source) => source.enabled);
    },
    async upsertSource(companyId: string, input: ForagingSourceInput) {
      const existing = [...sources.values()].find(
        (source) => source.companyId === companyId && source.role === input.role && source.url === input.url,
      );
      if (existing) {
        existing.kind = input.kind;
        existing.enabled = input.enabled ?? true;
        return existing;
      }
      const created: ForagingSourceRow = {
        id: `source-${sources.size + 1}`,
        companyId,
        role: input.role,
        url: input.url,
        kind: input.kind,
        enabled: input.enabled ?? true,
        lastSnapshot: null,
        lastSnapshotAt: null,
        lastCheckedAt: null,
        lastError: null,
      };
      sources.set(created.id, created);
      return created;
    },
    async deleteSource(_companyId: string, sourceId: string) {
      return sources.delete(sourceId);
    },
    async saveSnapshot(_companyId: string, sourceId: string, patch) {
      const source = sources.get(sourceId);
      if (source) {
        source.lastSnapshot = patch.lastSnapshot;
        source.lastSnapshotAt = patch.lastSnapshotAt;
        source.lastCheckedAt = patch.lastCheckedAt;
        source.lastError = patch.lastError;
      }
    },
    async saveRead(_companyId: string, sourceId: string, patch) {
      const source = sources.get(sourceId);
      if (source) {
        source.lastCheckedAt = patch.lastCheckedAt;
        source.lastError = patch.lastError;
      }
    },
    // 1.6.1: the spend ledger stubs the pass writes through.
    async insertSpendEvent() {},
    async spendWindows() {
      return { dayCents: 0, monthCents: 0, byRole: new Map<string, number>(), byAgent: new Map<string, number>() };
    },
    async spendBreakdown() {
      return [];
    },
    async insertFinding(input: ForagingFindingInsert) {
      const finding: ForagingFindingRow = { ...input, id: `finding-${findings.length + 1}` };
      findings.push(finding);
      return finding;
    },
    async listFindings(_companyId: string, limit: number) {
      return findings.slice(0, limit);
    },
    async listUnverifiedFindings(_companyId: string, limit: number) {
      return findings.filter((finding) => finding.status === "unverified").slice(0, limit);
    },
    async markFindingCandidate(_companyId: string, findingId: string, status, candidateRef, reason) {
      const finding = findings.find((item) => item.id === findingId);
      if (finding) {
        finding.status = status;
        finding.candidateRef = candidateRef;
        finding.reason = reason;
      }
    },
    async monthFindingCount() {
      return findings.length;
    },
    async listCompanyIds() {
      return [...new Set([...sources.values()].map((source) => source.companyId))];
    },
  };
  return store;
}

function fakeReader(bodies: Record<string, string>): ForagingReader {
  return {
    async read(source) {
      const body = bodies[source.url];
      if (body === undefined) throw new Error("unreachable in test");
      return { text: body, bytes: body.length };
    },
  };
}

const EMPTY_PORT: ForagingCandidatePort = {
  available: false,
  async createFindingCandidate() {
    return null;
  },
};

// 1.6.1: the resolved settings the pass reads (env-only views).
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

const PASS_BUDGET_1_SETTINGS = { ...NO_LIMITS_SETTINGS, passBudgetCents: 1 } as const;

const DEFAULTS_SETTINGS = { ...NO_LIMITS_SETTINGS, passBudgetCents: 50 } as const;

/** An idle check whose answers the test scripts per role. */
function scriptedIdleCheck(reasonsByRole: Record<string, "queue_not_empty" | "no_idle_agent" | null>): ForagingIdleCheck & {
  setRole(role: string, reason: "queue_not_empty" | "no_idle_agent" | null): void;
} {
  const reasons = { ...reasonsByRole };
  return {
    setRole(role, reason) {
      reasons[role] = reason;
    },
    async roleIdleReason(_companyId, role) {
      return reasons[role] ?? null;
    },
  };
}

/**
 * A settings-page stand-in: the general row the gate reads on every pass,
 * mutable between passes (the whole point of "no restart").
 */
function fakeGeneralStore(start: Record<string, unknown> = {}) {
  const state = { general: { ...start } };
  return {
    state,
    getGeneral: async () => state.general,
    set(key: string, value: unknown) {
      state.general[key] = value;
    },
  };
}

function baseDeps(overrides: Partial<Parameters<typeof createForagingService>[0]> = {}) {
  return {
    resolveSettings: async () => ({
      enabled: true,
      intervalMs: 3_600_000,
      budget: { maxCostCents: 0, enabled: false },
      settings: { ...NO_LIMITS_SETTINGS },
    }),
    db: {} as Parameters<typeof createForagingService>[0]["db"],
    ...overrides,
  };
}

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE) gate in the sweep pass", () => {
  it("acceptance 1: a role with a queued unassigned task is skipped with queue_not_empty", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "one\ntwo\n" }),
      candidatePort: EMPTY_PORT,
      idleGate: fakeGeneralStore(),
      idleCheck: scriptedIdleCheck({ engineer: "queue_not_empty" }),
    });
    const result = await service.runPass("company-a");
    expect(result.skippedReason).toBe("queue_not_empty");
    expect(result.sourcesRead).toBe(0);
    expect(store.sources.get("s1")?.lastSnapshot).toBeNull();
  });

  it("acceptance 1 (journal): the skip reason is logged", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const logAdapter: Pick<Logger, "info" | "warn" | "error"> = {
      info: (...a: Parameters<Logger["info"]>) => (log.info as (...x: unknown[]) => void)(...a),
      warn: (...a: Parameters<Logger["warn"]>) => (log.warn as (...x: unknown[]) => void)(...a),
      error: (...a: Parameters<Logger["error"]>) => (log.error as (...x: unknown[]) => void)(...a),
    };
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({}),
      candidatePort: EMPTY_PORT,
      idleGate: fakeGeneralStore(),
      idleCheck: scriptedIdleCheck({ engineer: "no_idle_agent" }),
      log: logAdapter,
    });
    await service.runPass("company-a");
    const skipCall = log.info.mock.calls.find((args: unknown[]) => String(args[1]).includes("role is busy"));
    expect(skipCall).toBeDefined();
    expect(skipCall?.[0]).toMatchObject({ role: "engineer", reason: "no_idle_agent" });
  });

  it("acceptance 2: an empty queue plus a free agent lets the pass read the source", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "one\ntwo\n" }),
      candidatePort: EMPTY_PORT,
      idleGate: fakeGeneralStore(),
      idleCheck: scriptedIdleCheck({ engineer: null }),
    });
    const result = await service.runPass("company-a");
    expect(result.skippedReason).toBeUndefined();
    expect(result.sourcesRead).toBe(1);
    expect(store.sources.get("s1")?.lastSnapshot).toEqual(["one", "two"]);
  });

  it("acceptance 3: switching the toggle off restores the old behaviour WITHOUT recreating the service", async () => {
    // The gate is ON and the role is busy: the pass skips.
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const general = fakeGeneralStore();
    const idleCheck = scriptedIdleCheck({ engineer: "queue_not_empty" });
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "one\ntwo\n" }),
      candidatePort: EMPTY_PORT,
      idleGate: general,
      idleCheck,
    });
    const first = await service.runPass("company-a");
    expect(first.skippedReason).toBe("queue_not_empty");
    expect(first.sourcesRead).toBe(0);

    // The operator flips the toggle off on the settings page — the same
    // service object, the very next pass, reads the source.
    general.set("foragingIdleGate", { enabled: false });
    const second = await service.runPass("company-a");
    expect(second.skippedReason).toBeUndefined();
    expect(second.sourcesRead).toBe(1);
    expect(store.sources.get("s1")?.lastSnapshot).toEqual(["one", "two"]);

    // And back on: the busy role is skipped again (still the same service).
    general.set("foragingIdleGate", { enabled: true });
    const third = await service.runPass("company-a");
    expect(third.sourcesRead).toBe(0); // the busy role is skipped again
    expect(third.skippedReason).toBe("queue_not_empty");
  });

  it("a busy role does not abort the sweep: other roles' sources are still read", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "engineer", url: "https://example.com/eng" },
      { id: "s2", role: "smm", url: "https://example.com/smm" },
    ]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({
        "https://example.com/eng": "e",
        "https://example.com/smm": "s",
      }),
      candidatePort: EMPTY_PORT,
      idleGate: fakeGeneralStore(),
      idleCheck: scriptedIdleCheck({ engineer: "queue_not_empty", smm: null }),
    });
    const result = await service.runPass("company-a");
    expect(result.sourcesRead).toBe(1);
    expect(store.sources.get("s1")?.lastSnapshot).toBeNull(); // engineer skipped
    expect(store.sources.get("s2")?.lastSnapshot).toEqual(["s"]); // smm read
  });

  it("no idle agent of the role skips its sources with no_idle_agent", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "x" }),
      candidatePort: EMPTY_PORT,
      idleGate: fakeGeneralStore(),
      idleCheck: scriptedIdleCheck({ engineer: "no_idle_agent" }),
    });
    const result = await service.runPass("company-a");
    expect(result.skippedReason).toBe("no_idle_agent");
    expect(result.sourcesRead).toBe(0);
  });

  it("without the toggle wiring the gate is not applied, so the pass keeps reading", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "x" }),
      candidatePort: EMPTY_PORT,
      idleCheck: scriptedIdleCheck({ engineer: "queue_not_empty" }),
    });
    // No toggle wired (an embedder without the settings row): the gate is not
    // applied at all — the pre-gate behaviour, and the reason the initial
    // `gateEnabled` is false.
    const result = await service.runPass("company-a");
    expect(result.skippedReason).toBeUndefined();
    expect(result.sourcesRead).toBe(1);
  });

  it("an unreadable settings row reads as \"nothing stored\", so the default (on) applies", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "x" }),
      candidatePort: EMPTY_PORT,
      idleGate: {
        getGeneral: async () => {
          throw new Error("the settings row is unreadable");
        },
      },
      idleCheck: scriptedIdleCheck({ engineer: "queue_not_empty" }),
    });
    // readForagingIdleGate treats a failed read as "the row holds nothing"
    // (the documented fail-open of the resolver, idle-gate-settings.ts) and
    // the default is ON, so the busy role is still skipped — the resolved
    // value reports its source as "default" to the screen, which is what
    // makes the fallback visible instead of silent.
    const result = await service.runPass("company-a");
    expect(result.skippedReason).toBe("queue_not_empty");
    expect(result.sourcesRead).toBe(0);
  });

  it("the idle check runs once per role per pass, not once per source", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "engineer", url: "https://example.com/a" },
      { id: "s2", role: "engineer", url: "https://example.com/b" },
    ]);
    const roleIdleReason = vi.fn(
      async () => null as "queue_not_empty" | "no_idle_agent" | null,
    );
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "a", "https://example.com/b": "b" }),
      candidatePort: EMPTY_PORT,
      idleGate: fakeGeneralStore(),
      idleCheck: { roleIdleReason },
    });
    await service.runPass("company-a");
    expect(roleIdleReason).toHaveBeenCalledTimes(1);
  });

  it("a stored setting beats the env value (settings page is the source of truth)", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const general = fakeGeneralStore({ foragingIdleGate: { enabled: true } });
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "x" }),
      candidatePort: EMPTY_PORT,
      idleGate: { getGeneral: general.getGeneral, env: { MYRMIDON_FORAGING_IDLE_GATE_ENABLED: "0" } },
      idleCheck: scriptedIdleCheck({ engineer: "queue_not_empty" }),
    });
    // The stored settings page value says ON, the env says OFF: the stored
    // value wins (the env is only the override for an instance that never
    // saved the setting), so the busy role is skipped.
    const result = await service.runPass("company-a");
    expect(result.skippedReason).toBe("queue_not_empty");
    expect(result.sourcesRead).toBe(0);
  });

  it("an unreadable stored value falls back to the default (gate on)", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const general = fakeGeneralStore({ foragingIdleGate: "not-an-object" });
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({}),
      candidatePort: EMPTY_PORT,
      idleGate: general,
      idleCheck: scriptedIdleCheck({ engineer: "queue_not_empty" }),
    });
    const result = await service.runPass("company-a");
    expect(result.skippedReason).toBe("queue_not_empty");
    expect(result.sourcesRead).toBe(0);
  });
});

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE) sweep pass (regression, no gate)", () => {
  it("records a baseline on the first read and no finding", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/a": "one\ntwo\n" }),
      candidatePort: EMPTY_PORT,
      // 1.6.1: the service resolves its settings on every pass now; the test
      // wires the same env-only view the old `settings` field carried.
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
    });
    const result = await service.runPass("company-a");
    expect(result.sourcesRead).toBe(1);
    expect(result.findings).toBe(0);
    expect(store.sources.get("s1")?.lastSnapshot).toEqual(["one", "two"]);
  });

  it("produces a diff finding when the source changed since the last snapshot", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["one", "two"] },
    ]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo\nthree\n" }),
      candidatePort: EMPTY_PORT,
      // 1.6.1: the service resolves its settings on every pass now; the test
      // wires the same env-only view the old `settings` field carried.
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
    });
    const result = await service.runPass("company-a");
    expect(result.findings).toBe(1);
    const [finding] = store.findings;
    expect(finding.diff).toEqual({ added: ["three"], removed: [] });
    expect(finding.skillKey).toBe("foraged-smm");
    expect(finding.status).toBe("unverified");
  });

  it("opens no finding when the source is unchanged", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["two", "one"] },
    ]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo" }),
      candidatePort: EMPTY_PORT,
      // 1.6.1: the service resolves its settings on every pass now; the test
      // wires the same env-only view the old `settings` field carried.
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
    });
    const result = await service.runPass("company-a");
    expect(result.findings).toBe(0);
    expect(store.findings).toHaveLength(0);
  });

  it("turns a finding into a candidate through the port (stand-in for SKILL-LIFECYCLE)", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["one"] },
    ]);
    const createFindingCandidate = vi.fn(
      async (_input: ForagingCandidateInput): Promise<string | null> => "candidate-42",
    );
    const port: ForagingCandidatePort = { available: true, createFindingCandidate };
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo" }),
      candidatePort: port,
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
    });
    const result = await service.runPass("company-a");
    expect(createFindingCandidate).toHaveBeenCalledTimes(1);
    expect(createFindingCandidate.mock.calls[0][0]).toMatchObject({
      companyId: "company-a",
      sourceId: "s1",
      role: "smm",
      skillKey: "foraged-smm",
      diff: { added: ["two"], removed: [] },
    });
    expect(result.candidates).toBe(1);
    expect(store.findings[0].status).toBe("candidate");
    expect(store.findings[0].candidateRef).toBe("candidate-42");
  });

  it("keeps a finding unverified when the port refuses it", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["one"] },
    ]);
    const port: ForagingCandidatePort = { available: true, async createFindingCandidate() { return null; } };
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo" }),
      candidatePort: port,
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
    });
    await service.runPass("company-a");
    expect(store.findings[0].status).toBe("rejected");
  });

  it("stops the pass once the budget ceiling is reached", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "a", url: "https://example.com/one", lastSnapshot: ["x"] },
      { id: "s2", role: "b", url: "https://example.com/two", lastSnapshot: ["y"] },
    ]);
    const read = vi.fn(async (source: { url: string }) => ({ text: "x", bytes: 1024 }));
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: { read },
      candidatePort: EMPTY_PORT,
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 1, enabled: true },
        settings: { ...PASS_BUDGET_1_SETTINGS },
      }),
    });
    const result = await service.runPass("company-a");
    expect(result.stoppedByBudget).toBe(true);
    expect(result.sourcesRead).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.spentCents).toBe(1);
  });

  it("continues the pass when one source fails, recording the error", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "a", url: "https://example.com/broken" },
      { id: "s2", role: "b", url: "https://example.com/ok" },
    ]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: {
        async read(source) {
          if (source.url.endsWith("broken")) throw new Error("source answered 500");
          return { text: "ok", bytes: 2 };
        },
      },
      candidatePort: EMPTY_PORT,
      // 1.6.1: the service resolves its settings on every pass now; the test
      // wires the same env-only view the old `settings` field carried.
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
    });
    const result = await service.runPass("company-a");
    expect(result.errors).toBe(1);
    expect(result.sourcesRead).toBe(1);
    expect(store.sources.get("s1")?.lastError).toContain("500");
  });

  it("skips disabled sources", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "a", url: "https://example.com/off", enabled: false },
    ]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({ "https://example.com/off": "x" }),
      candidatePort: EMPTY_PORT,
      // 1.6.1: the service resolves its settings on every pass now; the test
      // wires the same env-only view the old `settings` field carried.
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 0, enabled: false },
        settings: { ...NO_LIMITS_SETTINGS },
      }),
    });
    const result = await service.runPass("company-a");
    expect(result.sourcesRead).toBe(0);
  });

  it("reports the budget state for the screen", async () => {
    const store = createMemoryStore([{ id: "s1", role: "a", url: "https://example.com/" }]);
    const service = createForagingService({
      ...baseDeps(),
      store,
      reader: fakeReader({}),
      candidatePort: EMPTY_PORT,
      resolveSettings: async () => ({
        enabled: true,
        intervalMs: 3_600_000,
        budget: { maxCostCents: 50, enabled: true },
        settings: { ...DEFAULTS_SETTINGS },
      }),
    });
    const state = await service.budgetState("company-a");
    expect(state.maxCostCents).toBe(50);
    expect(state.spentCents).toBeLessThanOrEqual(50);
  });
});
