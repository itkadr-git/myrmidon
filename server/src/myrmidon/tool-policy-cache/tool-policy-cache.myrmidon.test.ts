/**
 * Tool gateway policy cache (myrmidon DB-PERF-C-P4).
 *
 * The cache is exercised from three sides:
 *  - the pure cache with an injected loader and clock: TTL window, invalidation,
 *    the switched-off mode, the eviction cap;
 *  - the wired path with a fake database handle, the real instance settings
 *    service and the real `toolAccessPolicyService`: the TTL comes from the
 *    instance setting, a policy change is visible to the very next decision, and
 *    with the cache off every decision reads the policy tables again;
 *  - the settings contract and the settings service behind
 *    `PATCH /api/myrmidon/tool-policy-cache`.
 *
 * The fake database handle keeps rows per table and applies `insert`, `update`
 * and `delete` to them, so the service code under test is the production one.
 * It ignores `where` predicates (each table holds one company here) and returns
 * whole rows for projected selects; it counts the SELECTs per table, which is
 * what the read-amplification assertions below are built on.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents,
  instanceSettings,
  principalPermissionGrants,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  applyToolPolicyCachePatch,
  instanceGeneralSettingsSchema,
  normalizeToolPolicyCacheSettings,
  patchToolPolicyCacheSettingsSchema,
  resolveToolPolicyCacheTtlMs,
  TOOL_POLICY_CACHE_DEFAULT_TTL_MS,
  TOOL_POLICY_CACHE_MAX_TTL_MS,
  toolPolicyCacheSettingsSchema,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { toolAccessPolicyService } from "../../services/tool-access-policy.js";
import { createToolPolicyCache } from "./cache.js";
import {
  __resetToolPolicyCachesForTests,
  invalidateAllToolPolicyCaches,
  readToolPolicySnapshot,
  toolPolicyCacheStats,
} from "./runtime.js";
import { toolPolicyCacheSettingsService } from "./settings-routes.js";

const COMPANY = "company-a";
const AGENT = "agent-a";
const CONNECTION = "connection-a";
const APPLICATION = "application-a";
const CATALOG_ENTRY = "catalog-entry-a";
const PROFILE = "profile-a";
const POLICY = "policy-a";

const START = Date.parse("2026-01-01T00:00:00.000Z");

type Row = Record<string, unknown>;

/** The tables the gateway decision touches, in the order the tests read them. */
const TABLES: Array<[string, unknown]> = [
  ["agents", agents],
  ["instanceSettings", instanceSettings],
  ["principalPermissionGrants", principalPermissionGrants],
  ["toolApplications", toolApplications],
  ["toolCatalogEntries", toolCatalogEntries],
  ["toolConnections", toolConnections],
  ["toolPolicies", toolPolicies],
  ["toolProfileBindings", toolProfileBindings],
  ["toolProfileEntries", toolProfileEntries],
  ["toolProfiles", toolProfiles],
];

interface FakeDb {
  db: Db;
  rows(name: string): Row[];
  selects(name: string): number;
}

function createFakeDb(seed: Record<string, Row[]>): FakeDb {
  const rows = new Map<string, Row[]>();
  const selectCounts = new Map<string, number>();
  let generated = 0;

  for (const [name, table] of TABLES) {
    rows.set(name, (seed[name] ?? []).map((row) => ({ ...row })));
    void table;
  }

  const nameOf = (table: unknown): string => {
    const match = TABLES.find(([, candidate]) => candidate === table);
    if (!match) throw new Error("fake db: unknown table");
    return match[0];
  };

  const chain = (name: string, current: Row[]): Record<string, unknown> => ({
    where: () => chain(name, current),
    orderBy: () => chain(name, current),
    limit: (count: number) => chain(name, current.slice(0, count)),
    offset: () => chain(name, current),
    then: (onFulfilled: (value: Row[]) => unknown, onRejected?: (error: unknown) => unknown) =>
      Promise.resolve(current.map((row) => ({ ...row }))).then(onFulfilled, onRejected),
  });

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const name = nameOf(table);
        selectCounts.set(name, (selectCounts.get(name) ?? 0) + 1);
        return chain(name, rows.get(name) ?? []);
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) => {
        const name = nameOf(table);
        const list = Array.isArray(values) ? values : [values];
        const inserted = list.map((row) => ({
          id: typeof row.id === "string" ? row.id : `${name}-${++generated}`,
          ...row,
        }));
        rows.set(name, [...(rows.get(name) ?? []), ...inserted]);
        const result: Record<string, unknown> = {
          returning: async () => inserted.map((row) => ({ ...row })),
          onConflictDoNothing: () => result,
          onConflictDoUpdate: () => result,
          then: (onFulfilled: (value: Row[]) => unknown, onRejected?: (error: unknown) => unknown) =>
            Promise.resolve(inserted).then(onFulfilled, onRejected),
        };
        return result;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          const name = nameOf(table);
          rows.set(name, (rows.get(name) ?? []).map((row) => ({ ...row, ...values })));
          const updated = rows.get(name) ?? [];
          return {
            returning: async () => updated.map((row) => ({ ...row })),
            then: (onFulfilled: (value: Row[]) => unknown) => Promise.resolve(updated).then(onFulfilled),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        const name = nameOf(table);
        const removed = rows.get(name) ?? [];
        rows.set(name, []);
        return {
          returning: async () => removed.map((row) => ({ ...row })),
        };
      },
    }),
  };

  return {
    db: db as unknown as Db,
    rows: (name) => rows.get(name) ?? [],
    selects: (name) => selectCounts.get(name) ?? 0,
  };
}

function policyRow(overrides: Row = {}): Row {
  return {
    id: POLICY,
    companyId: COMPANY,
    name: "policy-a",
    description: "block echo for the gateway decision test",
    policyType: "block",
    priority: 10,
    enabled: true,
    selectors: { toolNames: ["echo"] },
    conditions: null,
    config: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(START),
    updatedAt: new Date(START),
  };
}

function profileRow(): Row {
  return {
    id: PROFILE,
    companyId: COMPANY,
    profileKey: "profile-a",
    name: "profile-a",
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: {},
    createdAt: new Date(START),
    updatedAt: new Date(START),
  };
}

function seed(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    instanceSettings: [
      {
        id: "settings-1",
        singletonKey: "default",
        general: { toolPolicyCache: { ttlMs: TOOL_POLICY_CACHE_DEFAULT_TTL_MS } },
        experimental: {},
        createdAt: new Date(START),
        updatedAt: new Date(START),
      },
    ],
    agents: [{ id: AGENT, companyId: COMPANY, name: "agent-a" }],
    toolApplications: [
      {
        id: APPLICATION,
        companyId: COMPANY,
        status: "active",
        type: "mcp_http",
        applicationKey: "example-app",
      },
    ],
    toolConnections: [
      {
        id: CONNECTION,
        companyId: COMPANY,
        status: "active",
        enabled: true,
        applicationId: APPLICATION,
        transport: "mcp_remote",
      },
    ],
    toolCatalogEntries: [
      {
        id: CATALOG_ENTRY,
        companyId: COMPANY,
        connectionId: CONNECTION,
        applicationId: APPLICATION,
        status: "active",
        toolName: "echo",
        name: "echo",
        riskLevel: "low",
        versionHash: "v1",
        schemaHash: "s1",
      },
    ],
    toolPolicies: [policyRow()],
    toolProfileBindings: [
      {
        id: "binding-a",
        companyId: COMPANY,
        profileId: PROFILE,
        targetType: "company",
        targetId: COMPANY,
        priority: 10,
        metadata: {},
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date(START),
        updatedAt: new Date(START),
      },
    ],
    toolProfiles: [profileRow()],
    toolProfileEntries: [
      {
        id: "profile-entry-a",
        companyId: COMPANY,
        profileId: PROFILE,
        selectorType: "catalog_entry",
        effect: "include",
        applicationId: null,
        connectionId: null,
        catalogEntryId: CATALOG_ENTRY,
        toolName: null,
        riskLevel: null,
        conditions: null,
        createdAt: new Date(START),
        updatedAt: new Date(START),
      },
    ],
    principalPermissionGrants: [],
    ...overrides,
  };
}

/** The input the gateway builds for one `echo` call by the seeded agent. */
function decisionInput() {
  return {
    companyId: COMPANY,
    actor: { actorType: "agent" as const, actorId: AGENT, agentId: AGENT },
    request: { catalogEntryId: CATALOG_ENTRY, toolName: "echo", arguments: { text: "hello" } },
  };
}

describe("tool policy cache: TTL window, invalidation and switch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function pureCache(ttlMs: () => number, cap?: number) {
    const loaded: string[] = [];
    const cache = createToolPolicyCache({
      load: async (companyId) => {
        loaded.push(companyId);
        return {
          bindings: [],
          profiles: [profileRow() as never],
          entries: [],
          policies: [policyRow() as never],
        };
      },
      readTtlMs: ttlMs,
      cap,
    });
    return { cache, loaded };
  }

  it("loads once per company inside the TTL window", async () => {
    const { cache, loaded } = pureCache(() => 30_000);

    const first = await cache.read(COMPANY);
    vi.advanceTimersByTime(5_000);
    const second = await cache.read(COMPANY);

    expect(loaded).toEqual([COMPANY]);
    expect(second).toBe(first);
    expect(cache.stats()).toMatchObject({ companies: 1, loads: 1, hits: 1, misses: 1, ttlMs: 30_000 });
  });

  it("loads again once the TTL has passed, keeping the same row sets", async () => {
    const { cache, loaded } = pureCache(() => 30_000);

    const first = await cache.read(COMPANY);
    vi.advanceTimersByTime(30_000);
    const second = await cache.read(COMPANY);

    expect(loaded).toEqual([COMPANY, COMPANY]);
    expect(second).not.toBe(first);
    expect(second?.policies).toEqual(first?.policies);
    expect(second?.profiles).toEqual(first?.profiles);
  });

  it("reports no snapshot and keeps nothing while ttlMs is 0", async () => {
    let ttlMs = 0;
    const { cache, loaded } = pureCache(() => ttlMs);

    expect(await cache.read(COMPANY)).toBeNull();
    expect(await cache.read(COMPANY)).toBeNull();

    expect(loaded).toEqual([]);
    expect(cache.peek(COMPANY)).toBeNull();
    expect(cache.stats()).toMatchObject({ companies: 0, loads: 0, misses: 2, ttlMs: 0 });

    // Switching the window back on starts serving a snapshot again.
    ttlMs = 30_000;
    expect(await cache.read(COMPANY)).not.toBeNull();
    expect(loaded).toEqual([COMPANY]);
    expect(cache.stats()).toMatchObject({ companies: 1, loads: 1, ttlMs: 30_000 });
  });

  it("drops a snapshot taken before the cache was switched off", async () => {
    let ttlMs = 30_000;
    const { cache } = pureCache(() => ttlMs);

    await cache.read(COMPANY);
    expect(cache.peek(COMPANY)).not.toBeNull();

    ttlMs = 0;
    await cache.read(COMPANY);
    expect(cache.peek(COMPANY)).toBeNull();
  });

  it("serves the new TTL as soon as the provider reports it", async () => {
    let ttlMs = 30_000;
    const { cache, loaded } = pureCache(() => ttlMs);

    await cache.read(COMPANY);
    ttlMs = 120_000;
    vi.advanceTimersByTime(30_000);
    await cache.read(COMPANY);

    // Still the first snapshot: the longer window is in force from the change on.
    expect(loaded).toEqual([COMPANY]);
    expect(cache.stats().ttlMs).toBe(120_000);
  });

  it("invalidates one company and every company", async () => {
    const { cache, loaded } = pureCache(() => 300_000);

    await cache.read(COMPANY);
    await cache.read("company-b");
    expect(cache.stats().companies).toBe(2);

    cache.invalidate(COMPANY);
    await cache.read("company-b");
    expect(loaded).toEqual([COMPANY, "company-b"]);

    await cache.read(COMPANY);
    expect(loaded).toEqual([COMPANY, "company-b", COMPANY]);

    cache.invalidateAll();
    expect(cache.stats().companies).toBe(0);
    await cache.read(COMPANY);
    await cache.read("company-b");
    expect(loaded).toHaveLength(5);
  });

  it("keeps at most the configured number of companies and evicts the oldest", async () => {
    const { cache, loaded } = pureCache(() => 300_000, 2);

    await cache.read(COMPANY);
    await cache.read("company-b");
    await cache.read("company-c");

    expect(cache.stats().companies).toBe(2);
    expect(cache.peek(COMPANY)).toBeNull();
    expect(cache.peek("company-b")).not.toBeNull();

    // The two most recent companies are answered from the cache ...
    await cache.read("company-b");
    await cache.read("company-c");
    expect(loaded).toEqual([COMPANY, "company-b", "company-c"]);

    // ... and the evicted one is loaded again, which pushes the oldest out.
    await cache.read(COMPANY);
    expect(loaded).toEqual([COMPANY, "company-b", "company-c", COMPANY]);
    expect(cache.peek("company-b")).toBeNull();
    expect(cache.peek("company-c")).not.toBeNull();
    expect(cache.peek(COMPANY)).not.toBeNull();
  });
});

describe("tool policy cache: the gateway decision path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    __resetToolPolicyCachesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetToolPolicyCachesForTests();
  });

  it("answers decisions from one snapshot per TTL window", async () => {
    const fake = createFakeDb(seed());
    const policy = toolAccessPolicyService(fake.db);

    expect((await policy.decide(decisionInput())).reasonCode).toBe("deny_policy_block");
    expect((await policy.decide(decisionInput())).reasonCode).toBe("deny_policy_block");

    const stats = toolPolicyCacheStats(fake.db);
    expect(stats).toMatchObject({ companies: 1, loads: 1, hits: 1, misses: 1 });
    expect(fake.selects("toolProfileBindings")).toBe(1);
    expect(fake.selects("toolProfiles")).toBe(1);
    expect(fake.selects("toolProfileEntries")).toBe(1);
    expect(fake.selects("toolPolicies")).toBe(1);

    vi.advanceTimersByTime(30_001);
    expect((await policy.decide(decisionInput())).reasonCode).toBe("deny_policy_block");
    expect(toolPolicyCacheStats(fake.db).loads).toBe(2);
    expect(fake.selects("toolPolicies")).toBe(2);
  });

  it("sees a policy change on the very next decision, without waiting out the TTL", async () => {
    const fake = createFakeDb(seed());
    const policy = toolAccessPolicyService(fake.db);

    expect((await policy.decide(decisionInput())).reasonCode).toBe("deny_policy_block");
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ loads: 1, companies: 1 });

    // The policy is changed through the API: the next read of the company sees the new
    // row, with the clock untouched — the invalidation, not the TTL, dropped the snapshot.
    await policy.updatePolicy({ companyId: COMPANY, policyId: POLICY, body: { enabled: false } });

    const afterUpdate = await readToolPolicySnapshot(fake.db, COMPANY);
    expect(toolPolicyCacheStats(fake.db).loads).toBe(2);
    expect(fake.rows("toolPolicies")[0].enabled).toBe(false);
    expect(afterUpdate?.policies.map((row) => row.enabled)).toEqual([false]);

    // And a decision follows the change in the same way: with the block gone the
    // company profile's include entry allows the call.
    await policy.deletePolicy({ companyId: COMPANY, policyId: POLICY });

    const after = await policy.decide(decisionInput());
    expect(after.reasonCode).toBe("allow_profile");
    expect(after.decision).toBe("allow");
    expect(toolPolicyCacheStats(fake.db).loads).toBe(3);
  });

  it("reads the policy tables again on every decision while the cache is off", async () => {
    const fake = createFakeDb(
      seed({
        instanceSettings: [
          {
            id: "settings-1",
            singletonKey: "default",
            general: { toolPolicyCache: { ttlMs: 0 } },
            experimental: {},
            createdAt: new Date(START),
            updatedAt: new Date(START),
          },
        ],
      }),
    );
    const policy = toolAccessPolicyService(fake.db);

    expect(await readToolPolicySnapshot(fake.db, COMPANY)).toBeNull();

    expect((await policy.decide(decisionInput())).reasonCode).toBe("deny_policy_block");
    expect((await policy.decide(decisionInput())).reasonCode).toBe("deny_policy_block");

    // Nothing was cached, so both decisions ran the statements the gateway ran
    // before the cache existed.
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ companies: 0, loads: 0 });
    expect(fake.selects("toolProfileBindings")).toBe(2);
    expect(fake.selects("toolProfiles")).toBe(2);
    expect(fake.selects("toolProfileEntries")).toBe(2);
    expect(fake.selects("toolPolicies")).toBe(2);
  });
});

describe("tool policy cache: the instance setting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    __resetToolPolicyCachesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetToolPolicyCachesForTests();
  });

  it("takes the TTL from the stored setting, and the default when absent", async () => {
    const fake = createFakeDb(seed({ instanceSettings: [] }));
    const settings = instanceSettingsService(fake.db);

    const general = await settings.getGeneral();
    expect(general.toolPolicyCache).toBeUndefined();
    expect(resolveToolPolicyCacheTtlMs(normalizeToolPolicyCacheSettings(general.toolPolicyCache))).toBe(
      TOOL_POLICY_CACHE_DEFAULT_TTL_MS,
    );

    // The row is created on the first read, so the cache still gets the default.
    await readToolPolicySnapshot(fake.db, COMPANY);
    expect(toolPolicyCacheStats(fake.db).ttlMs).toBe(TOOL_POLICY_CACHE_DEFAULT_TTL_MS);

    // A stored window is used as it is.
    fake.rows("instanceSettings")[0].general = { toolPolicyCache: { ttlMs: 45_000 } };
    __resetToolPolicyCachesForTests();
    await readToolPolicySnapshot(fake.db, COMPANY);
    expect(toolPolicyCacheStats(fake.db).ttlMs).toBe(45_000);
  });

  it("drops every cached company of the process on demand", async () => {
    const fake = createFakeDb(seed());

    await readToolPolicySnapshot(fake.db, COMPANY);
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ companies: 1, loads: 1 });

    invalidateAllToolPolicyCaches(fake.db);
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ companies: 0, loads: 1 });

    await readToolPolicySnapshot(fake.db, COMPANY);
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ companies: 1, loads: 2 });
  });

  it("changes the TTL through the settings service without a restart", async () => {
    const fake = createFakeDb(seed());
    const settings = instanceSettingsService(fake.db);
    const service = toolPolicyCacheSettingsService({
      getGeneral: () => settings.getGeneral(),
      updateGeneral: (patch) => settings.updateGeneral(patch),
      stats: () => toolPolicyCacheStats(fake.db),
    });

    const read = async () => await readToolPolicySnapshot(fake.db, COMPANY);

    expect((await service.read()).effective).toMatchObject({
      ttlMs: 30_000,
      cacheEnabled: true,
      defaultTtlMs: TOOL_POLICY_CACHE_DEFAULT_TTL_MS,
      minTtlMs: 0,
      maxTtlMs: TOOL_POLICY_CACHE_MAX_TTL_MS,
    });

    await read();
    expect(toolPolicyCacheStats(fake.db).loads).toBe(1);

    // A window longer than the default: the snapshot survives a read that the old
    // TTL would have expired.
    const patched = await service.update({ ttlMs: 120_000 });
    expect(patched.settings).toEqual({ ttlMs: 120_000 });
    vi.advanceTimersByTime(60_000);
    await read();
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ loads: 1, ttlMs: 120_000 });

    // Switched off: the next read reports no snapshot and the gateway reads fresh.
    await service.update({ ttlMs: 0 });
    expect(await read()).toBeNull();
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ companies: 0, loads: 1, ttlMs: 0 });

    // Switched on again with a short window.
    await service.update({ ttlMs: 15_000 });
    expect(await read()).not.toBeNull();
    expect(toolPolicyCacheStats(fake.db)).toMatchObject({ loads: 2, ttlMs: 15_000 });

    // Null clears the field and the default returns.
    const cleared = await service.update({ ttlMs: null });
    expect(cleared.settings).toEqual({});
    expect(cleared.effective.ttlMs).toBe(TOOL_POLICY_CACHE_DEFAULT_TTL_MS);
  });

  it("keeps the setting across a vendor write of general", async () => {
    const fake = createFakeDb(seed());
    const settings = instanceSettingsService(fake.db);

    // A vendor write of a sibling general field (the agent-memory settings) must not
    // wipe the TTL.
    await settings.updateGeneral({ agentMemory: { enabled: false } });

    const general = await settings.getGeneral();
    expect(general.toolPolicyCache).toEqual({ ttlMs: 30_000 });
  });
});

describe("tool policy cache: settings contract", () => {
  it("accepts the whole range and rejects what is outside it", () => {
    expect(toolPolicyCacheSettingsSchema.safeParse({ ttlMs: 0 }).success).toBe(true);
    expect(toolPolicyCacheSettingsSchema.safeParse({ ttlMs: TOOL_POLICY_CACHE_MAX_TTL_MS }).success).toBe(true);
    expect(toolPolicyCacheSettingsSchema.safeParse({}).success).toBe(true);
    expect(toolPolicyCacheSettingsSchema.safeParse({ ttlMs: -1 }).success).toBe(false);
    expect(toolPolicyCacheSettingsSchema.safeParse({ ttlMs: TOOL_POLICY_CACHE_MAX_TTL_MS + 1 }).success).toBe(false);
    expect(toolPolicyCacheSettingsSchema.safeParse({ ttlMs: 1.5 }).success).toBe(false);
    expect(toolPolicyCacheSettingsSchema.safeParse({ ttlMs: "30000" }).success).toBe(false);
    expect(toolPolicyCacheSettingsSchema.safeParse({ ttlMs: 1_000, extra: true }).success).toBe(false);

    expect(patchToolPolicyCacheSettingsSchema.safeParse({ ttlMs: null }).success).toBe(true);
    expect(patchToolPolicyCacheSettingsSchema.safeParse({ ttlMs: 900_000 }).success).toBe(false);
  });

  it("normalizes a damaged stored value to the default and resolves the window", () => {
    expect(normalizeToolPolicyCacheSettings(undefined)).toEqual({});
    expect(normalizeToolPolicyCacheSettings("30000")).toEqual({});
    expect(normalizeToolPolicyCacheSettings({ ttlMs: -5 })).toEqual({});
    expect(normalizeToolPolicyCacheSettings({ ttlMs: 0 })).toEqual({ ttlMs: 0 });
    expect(normalizeToolPolicyCacheSettings({ ttlMs: 1_000 })).toEqual({ ttlMs: 1_000 });

    expect(resolveToolPolicyCacheTtlMs({})).toBe(TOOL_POLICY_CACHE_DEFAULT_TTL_MS);
    expect(resolveToolPolicyCacheTtlMs({ ttlMs: 0 })).toBe(0);
    expect(resolveToolPolicyCacheTtlMs({ ttlMs: 999_999_999 })).toBe(TOOL_POLICY_CACHE_MAX_TTL_MS);
    expect(resolveToolPolicyCacheTtlMs({ ttlMs: Number.NaN })).toBe(TOOL_POLICY_CACHE_DEFAULT_TTL_MS);
  });

  it("applies a patch and clears the field on null", () => {
    expect(applyToolPolicyCachePatch({ ttlMs: 1_000 }, { ttlMs: 2_000 })).toEqual({ ttlMs: 2_000 });
    expect(applyToolPolicyCachePatch({ ttlMs: 1_000 }, { ttlMs: null })).toEqual({});
    expect(applyToolPolicyCachePatch({ ttlMs: 1_000 }, {})).toEqual({ ttlMs: 1_000 });
    expect(applyToolPolicyCachePatch({}, { ttlMs: 0 })).toEqual({ ttlMs: 0 });
  });

  it("rides along in the general settings row", () => {
    const parsed = instanceGeneralSettingsSchema.safeParse({ toolPolicyCache: { ttlMs: 1_000 } });
    expect(parsed.success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ toolPolicyCache: { ttlMs: 999_999 } }).success).toBe(false);
    expect(instanceGeneralSettingsSchema.safeParse({ toolPolicyCache: { ttlMs: 1_000 }, nope: 1 }).success).toBe(false);
  });
});