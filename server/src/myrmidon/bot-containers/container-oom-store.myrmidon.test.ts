import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  containerOomRecorder,
  countAgentContainerOom,
} from "./container-oom-store.js";
import type { ContainerOomObservation } from "./container-oom.js";

function store(results: unknown[][]) {
  const values = vi.fn(async () => undefined);
  const execute = vi.fn(async () => undefined);
  const chain: any = {
    from() { return chain; },
    where() { return chain; },
    orderBy() { return chain; },
    limit: vi.fn(async () => results.shift() ?? []),
    then(resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) {
      return Promise.resolve(results.shift() ?? []).then(resolve, reject);
    },
  };
  const tx = { execute, select: () => chain, insert: () => ({ values }) };
  const db = {
    transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    select: () => chain,
  } as unknown as Db;
  return { db, values, execute };
}

const observation: ContainerOomObservation = {
  containerId: "container-a",
  occurredAt: "2026-10-27T12:00:00.000Z",
  memoryLimitBytes: 1024,
  source: "docker.events",
  cgroupOomKills: 2,
};
const agent = { companyId: "company-a", role: "engineer" };

describe("durable container OOM evidence & counter", () => {
  it("locks before deduplication and stores uniquely correlated event-time run with docker.events source", async () => {
    const s = store([[agent], [], [{ id: "run-at-event" }]]);
    await containerOomRecorder(s.db)("agent-a", observation);
    expect(s.execute).toHaveBeenCalledOnce();
    expect(s.values).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-a",
        agentId: "agent-a",
        runId: "run-at-event",
        action: "agent.container_oom",
        entityType: "container_oom",
        entityId: "container-a:2026-10-27T12:00:00.000Z:docker.events",
        details: expect.objectContaining({
          kind: "resource.oom",
          source: "docker.events",
          cgroupOomKills: 2,
          correlation: "event_time",
          peakMemoryBytes: null,
        }),
      }),
    );
  });

  it("does not duplicate replayed observations", async () => {
    const s = store([[agent], [{ id: "already-recorded" }]]);
    await containerOomRecorder(s.db)("agent-a", observation);
    expect(s.values).not.toHaveBeenCalled();
  });

  it.each([{ runs: [] }, { runs: [{ id: "a" }, { id: "b" }] }])(
    "never guesses a run when unmatched/ambiguous",
    async ({ runs }) => {
      const s = store([[agent], [], runs]);
      await containerOomRecorder(s.db)("agent-a", observation);
      expect(s.values).toHaveBeenCalledWith(expect.objectContaining({ runId: null }));
    },
  );

  it("ignores an unknown agent", async () => {
    const s = store([[]]);
    await containerOomRecorder(s.db)("agent-a", observation);
    expect(s.values).not.toHaveBeenCalled();
  });

  it("countAgentContainerOom returns count from activity log matching journalctl -k events", async () => {
    const s = store([[{ count: 3 }]]);
    const count = await countAgentContainerOom(s.db, "agent-a");
    expect(count).toBe(3);
  });
});
