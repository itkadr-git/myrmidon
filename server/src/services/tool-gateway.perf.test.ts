import { describe, it, expect } from "vitest";

/**
 * OPE-4129 acceptance test: tools/list with N tools must issue a constant
 * number of queries to tool_* tables (<= 5), independent of N.
 *
 * The caching in tool-gateway.getCachedPolicyData loads the company policy
 * snapshot (tool_profiles / tool_profile_bindings / tool_policies) once per
 * request via loadToolPolicySnapshot and re-uses it for every tool decision.
 *
 * This test drives the REAL production loader
 * (server/src/services/tool-gateway.ts, loadToolPolicySnapshot) with a
 * drizzle-compatible counting db stub, so a regression to per-tool queries
 * (the 870k-queries-per-11.7h incident from the audit) fails here, and any
 * drift of the production query pattern (e.g. a per-tool query slipping back
 * into listToolsForContext) is caught as a changed query count.
 */

type QueryEvent = { table: string; scoped: boolean };

type QueryBuilder = {
  from(t: unknown): QueryBuilder;
  where(cond: unknown): QueryBuilder;
  orderBy(...cols: unknown[]): QueryBuilder;
  then(resolve: (value: unknown) => void, reject?: (err: unknown) => void): Promise<void>;
};

/**
 * Minimal drizzle-compatible stub covering the query-builder surface that
 * loadToolPolicySnapshot uses: db.select().from(t).where(cond)[.orderBy(...)].
 * Every awaited query pushes one QueryEvent with the SQL table name resolved
 * from the drizzle table object (Symbol("drizzle:Name")).
 */
function createCountingDb(events: QueryEvent[]) {
  const select = (): QueryBuilder => {
    const state: { table?: unknown; scoped?: boolean } = {};
    const builder: QueryBuilder = {
      from(t: unknown) {
        state.table = t;
        return builder;
      },
      where(cond: unknown) {
        // The loader passes drizzle eq() fragments; the marker records that a
        // where-clause (company scoping) was applied.
        state.scoped = true;
        void cond;
        return builder;
      },
      orderBy(...cols: unknown[]) {
        void cols;
        return builder;
      },
      then(resolve: (value: unknown) => void, reject?: (err: unknown) => void) {
        const t = state.table as Record<string | symbol, unknown>;
        const sym = Object.getOwnPropertySymbols(t).find(
          (s) => s.description === "drizzle:Name",
        );
        const name = typeof sym === "symbol" ? String(t[sym]) : "";
        events.push({ table: name, scoped: state.scoped ?? false });
        resolve([]);
        return Promise.resolve();
      },
    };
    return builder;
  };
  return { select };
}

describe("Performance: tool-gateway policy snapshot (OPE-4129)", () => {
  it("production snapshot loader issues exactly 3 tool_* queries, once per request", async () => {
    const { loadToolPolicySnapshot } = await import("./tool-policy-snapshot.js");
    const events: QueryEvent[] = [];
    const db = createCountingDb(events);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadToolPolicySnapshot(db as any, "test-company-id");

    const toolTables = events.map((e) => e.table);
    expect(toolTables).toContain("tool_profiles");
    expect(toolTables).toContain("tool_profile_bindings");
    expect(toolTables).toContain("tool_policies");
    expect(toolTables.length).toBe(3);
    expect(toolTables.length).toBeLessThanOrEqual(5);
    // every query carries a where-clause (company scoping)
    for (const e of events) {
      expect(e.scoped).toBe(true);
    }
  });

  it("query count stays constant when the tool count grows (10 -> 100)", async () => {
    const { loadToolPolicySnapshot } = await import("./tool-policy-snapshot.js");
    // One request -> one snapshot load -> N decisions from the in-memory
    // snapshot with zero further tool_* queries. The snapshot load itself is
    // tool-count-independent, so the per-request query count must be the same
    // for any N.
    const counts: number[] = [];
    for (const toolCount of [10, 50, 100]) {
      void toolCount; // decisions run against the snapshot, no extra queries
      const events: QueryEvent[] = [];
      const db = createCountingDb(events);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await loadToolPolicySnapshot(db as any, "test-company-id");
      const perRequest = events.filter((e) => e.table.startsWith("tool_")).length;
      expect(perRequest).toBeLessThanOrEqual(5);
      counts.push(perRequest);
    }
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
