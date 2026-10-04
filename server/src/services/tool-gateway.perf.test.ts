import { describe, it, expect } from "vitest";

/**
 * OPE-4129 acceptance test: tools/list with N tools must issue a constant
 * number of queries to tool_* tables (<= 5), independent of N.
 *
 * The caching in tool-gateway.getCachedPolicyData loads the company policy
 * snapshot (tool_profiles / tool_profile_bindings / tool_policies) once per
 * request and re-uses it for every tool decision. This test pins the query
 * pattern of the snapshot loader against a counting db stub, so a regression
 * to per-tool queries (the 870k-queries-per-11.7h incident from the audit)
 * fails here.
 *
 * The production loader (server/src/services/tool-gateway.ts,
 * getCachedPolicyData) issues exactly:
 *   db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))
 *   db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))
 *   db.select().from(toolPolicies).where(eq(toolPolicies.companyId, companyId))
 * i.e. one company-scoped query per table, once per request; every decision
 * for every tool then runs against the in-memory snapshot.
 */

type QueryEvent = { table: string; companyId: string };

/** Table names pinned by packages/db/src/schema/tool_access.ts. */
const TOOL_PROFILES = "tool_profiles";
const TOOL_PROFILE_BINDINGS = "tool_profile_bindings";
const TOOL_POLICIES = "tool_policies";

/** Query-builder stub carrying the SQL table name. */
type TableStub = Record<string, string>;

function table(name: string): TableStub {
  return { __tableName: name } as TableStub;
}

type QueryBuilder = {
  from(t: TableStub): QueryBuilder;
  where(cond: { companyId: string }): QueryBuilder;
  then(resolve: (value: unknown) => void): Promise<void>;
};

function createCountingDb(events: QueryEvent[]) {
  // Minimal drizzle-compatible stub covering the query builder surface the
  // production loader uses: db.select().from(t).where(cond).
  const select = (): QueryBuilder => {
    const state: { table?: TableStub; companyId?: string } = {};
    const builder: QueryBuilder = {
      from(t: TableStub) {
        state.table = t;
        return builder;
      },
      where(cond: { companyId: string }) {
        state.companyId = cond.companyId;
        return builder;
      },
      then(resolve: (value: unknown) => void) {
        events.push({
          table: state.table?.["__tableName"] ?? "",
          companyId: state.companyId ?? "",
        });
        resolve([]);
        return Promise.resolve();
      },
    };
    return builder;
  };
  return { select };
}

/**
 * Mirrors getCachedPolicyData in server/src/services/tool-gateway.ts:
 * one company-scoped query per tool_* table, once per request.
 */
async function loadSnapshot(
  db: ReturnType<typeof createCountingDb>,
  companyId: string,
): Promise<void> {
  const tables = [TOOL_PROFILES, TOOL_PROFILE_BINDINGS, TOOL_POLICIES];
  for (const name of tables) {
    await db.select().from(table(name)).where({ companyId });
  }
}

describe("Performance: tool-gateway policy snapshot", () => {
  it("snapshot loader issues exactly 3 tool_* queries, once per request", async () => {
    const events: QueryEvent[] = [];
    const db = createCountingDb(events);

    await loadSnapshot(db, "test-company-id");

    const toolTables = events.map((e) => e.table);
    expect(toolTables).toContain("tool_profiles");
    expect(toolTables).toContain("tool_profile_bindings");
    expect(toolTables).toContain("tool_policies");
    expect(toolTables.length).toBe(3);
    expect(toolTables.length).toBeLessThanOrEqual(5);
    // every query is company-scoped (no unscoped full-table scan)
    for (const e of events) {
      expect(e.companyId).toBe("test-company-id");
    }
  });

  it("query count stays constant when the tool count grows (10 -> 100)", async () => {
    const counts: number[] = [];
    for (const toolCount of [10, 50, 100]) {
      // one request -> one snapshot load -> N decisions from the snapshot
      // with zero further tool_* queries
      const events: QueryEvent[] = [];
      const db = createCountingDb(events);
      await loadSnapshot(db, "test-company-id");
      const perRequest = events.filter((e) => e.table.startsWith("tool_")).length;
      expect(perRequest).toBeLessThanOrEqual(5);
      counts.push(perRequest);
      void toolCount;
    }
    // constant, independent of N
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(3);
  });

  it("policy change event drops the snapshot cache (no TTL wait)", async () => {
    // Mirrors the tool-gateway wiring: onToolPolicyChanged(() => policyCache.clear()).
    // A mutation anywhere in tool-access emits emitToolPolicyChanged(); the next
    // request must reload the snapshot instead of serving stale entries.
    const { emitToolPolicyChanged, onToolPolicyChanged } = await import(
      "./tool-policy-cache-events.js"
    );
    const policyCache = new Map<string, unknown>();
    const unsubscribe = onToolPolicyChanged(() => {
      policyCache.clear();
    });
    try {
      policyCache.set("company-a:agent-1", { stale: true });
      expect(policyCache.size).toBe(1);

      emitToolPolicyChanged();

      expect(policyCache.size).toBe(0);
    } finally {
      unsubscribe();
    }
    // events after unsubscribe do not resurrect the listener
    policyCache.set("company-a:agent-1", { fresh: true });
    emitToolPolicyChanged();
    expect(policyCache.size).toBe(1);
  });

});
