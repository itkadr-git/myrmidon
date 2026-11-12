// server/src/myrmidon/bot-containers/container-oom.myrmidon.test.ts
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  containerOomObservation,
  dockerEventOomObservation,
  type DriverOomEvent,
} from "./container-oom.js";
import { syncOomEventsOfSweep } from "./index.js";

describe("container-oom", () => {
  it("extracts docker.inspect OOM observation when OOMKilled is true", () => {
    const obs = containerOomObservation({
      Id: "container-123",
      State: { OOMKilled: true, FinishedAt: "2026-10-30T10:00:00.000Z" },
      HostConfig: { Memory: 2147483648 },
    });
    expect(obs).toEqual({
      containerId: "container-123",
      occurredAt: "2026-10-30T10:00:00.000Z",
      memoryLimitBytes: 2147483648,
      source: "docker.inspect",
    });
  });

  it("returns null when OOMKilled is false or timestamp is year-0001 sentinel", () => {
    expect(
      containerOomObservation({
        Id: "container-123",
        State: { OOMKilled: false, FinishedAt: "2026-10-30T10:00:00.000Z" },
      }),
    ).toBeNull();

    expect(
      containerOomObservation({
        Id: "container-123",
        State: { OOMKilled: true, FinishedAt: "0001-01-01T00:00:00Z" },
      }),
    ).toBeNull();
  });

  it.each([undefined, "not-a-date", "0001-01-01T00:00:00Z"])("rejects missing/invalid finish time %s", (FinishedAt) => {
    expect(containerOomObservation({ Id: "container-a", State: { OOMKilled: true, FinishedAt } })).toBeNull();
  });

  it.each([0, -1, NaN, Infinity, 1.5])("does not report invalid limit %s", (Memory) => {
    expect(containerOomObservation({ Id: "container-a", State: { OOMKilled: true, FinishedAt: "2026-10-30T10:00:00.000Z" }, HostConfig: { Memory } })?.memoryLimitBytes).toBeNull();
  });

  it("extracts docker.events OOM observation for child-process OOM (live PID 1)", () => {
    const event: DriverOomEvent = {
      containerId: "c-child-456",
      botKey: "adm-dev-eng-25",
      name: "myrmidon-bot-adm-dev-eng-25",
      time: 1730000000,
      timeNano: 1730000000123456000,
      source: "docker.events",
      cgroupOomKills: 1,
    };
    const obs = dockerEventOomObservation(event, 1073741824);
    expect(obs).toEqual({
      containerId: "c-child-456",
      botKey: "adm-dev-eng-25",
      occurredAt: new Date(Math.floor(1730000000123456000 / 1e6)).toISOString(),
      memoryLimitBytes: 1073741824,
      source: "docker.events",
      cgroupOomKills: 1,
    });
  });

  it("syncOomEventsOfSweep queries driver.getOomEvents and records via containerOomRecorder", async () => {
    const events: DriverOomEvent[] = [
      {
        containerId: "cid-oom-1",
        botKey: "agent-a",
        time: 1730000000,
        timeNano: 1730000000100000000,
        source: "docker.events",
      },
    ];
    const getOomEvents = vi.fn(async () => events);
    const execute = vi.fn(async () => undefined);
    const values = vi.fn(async () => undefined);
    let limitCall = 0;
    const chain: any = {
      from() { return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit: vi.fn(async () => {
        limitCall++;
        if (limitCall === 1) return [{ companyId: "comp-1", role: "engineer" }];
        return [];
      }),
      then(resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) {
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    const tx = { execute, select: () => chain, insert: () => ({ values }) };
    const db = {
      transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    } as unknown as Db;

    const state = { lastSinceNano: 0 };
    const agents = [{ agentId: "agent-a", botKey: "agent-a", adapterType: "myrmidon", adapterConfig: {} }];

    await syncOomEventsOfSweep(
      agents as any,
      { driver: { getOomEvents } as any, db } as any,
      state,
    );

    expect(getOomEvents).toHaveBeenCalledWith(undefined);
    expect(state.lastSinceNano).toBe(1730000000100000000);
    expect(execute).toHaveBeenCalled();
    expect(values).toHaveBeenCalled();
  });

  it("syncOomEventsOfSweep retries unrecorded events on subsequent sweep when recorder fails", async () => {
    const events: DriverOomEvent[] = [
      {
        containerId: "cid-oom-fail",
        botKey: "agent-a",
        time: 1730000000,
        timeNano: 1730000000500000000,
        source: "docker.events",
      },
    ];
    let shouldFail = true;
    const getOomEvents = vi.fn(async (since?: number) => {
      if (since && since >= 1730000000500000000) {
        return [];
      }
      return events;
    });

    const execute = vi.fn(async () => undefined);
    const values = vi.fn(async () => undefined);
    let limitCall = 0;
    const chain: any = {
      from() { return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit: vi.fn(async () => {
        limitCall++;
        if (limitCall % 2 === 1) return [{ companyId: "comp-1", role: "engineer" }];
        return [];
      }),
      then(resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) {
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    const tx = { execute, select: () => chain, insert: () => ({ values }) };
    const db = {
      transaction: async (fn: (t: typeof tx) => unknown) => {
        if (shouldFail) {
          throw new Error("DB temporary failure");
        }
        return fn(tx);
      },
    } as unknown as Db;

    const state = { lastSinceNano: 0 };
    const agents = [{ agentId: "agent-a", botKey: "agent-a", adapterType: "myrmidon", adapterConfig: {} }];
    const deps = { driver: { getOomEvents } as any, db } as any;

    // First sweep: recorder fails due to DB error.
    await syncOomEventsOfSweep(agents as any, deps, state);

    // Watermark should NOT advance on failure.
    expect(state.lastSinceNano).toBe(0);
    expect(values).not.toHaveBeenCalled();

    // Second sweep: DB recovers.
    shouldFail = false;
    await syncOomEventsOfSweep(agents as any, deps, state);

    // getOomEvents was called again with undefined/0 since watermark didn't advance,
    // event was successfully processed, and watermark advanced.
    expect(getOomEvents).toHaveBeenCalledTimes(2);
    expect(getOomEvents).toHaveBeenLastCalledWith(undefined);
    expect(state.lastSinceNano).toBe(1730000000500000000);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("syncOomEventsOfSweep ignores non-bot container events and records bot event with uuid agentId", async () => {
    const botAgentId = "9c916eb2-9d0a-4ff1-bcf3-bb2176b6d511";
    const events: DriverOomEvent[] = [
      {
        containerId: "cid-foreign",
        botKey: "litellm-gateway",
        time: 100,
        timeNano: 1730000000100000000,
        source: "docker.events",
      },
      {
        containerId: "cid-bot",
        botKey: botAgentId,
        time: 200,
        timeNano: 1730000000200000000,
        source: "docker.events",
      },
    ];

    const getOomEvents = vi.fn(async () => events);
    let limitCall = 0;

    const chain: any = {
      from() { return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit: vi.fn(async () => {
        limitCall++;
        if (limitCall === 1) return [{ companyId: "comp-1", role: "engineer" }];
        if (limitCall === 2) return [];
        return [{ id: "run-1" }];
      }),
      then(resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) {
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    const values = vi.fn(async () => undefined);
    const tx = {
      execute: vi.fn(async () => undefined),
      select: () => chain,
      insert: () => ({ values }),
    };
    const db = {
      transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    } as unknown as Db;

    const state = { lastSinceNano: 0 };
    const agents = [{ agentId: botAgentId, botKey: botAgentId, adapterType: "myrmidon", adapterConfig: {} }];
    const deps = { driver: { getOomEvents } as any, db } as any;

    await syncOomEventsOfSweep(agents as any, deps, state);

    // Foreign event was skipped, bot event recorded
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ agentId: botAgentId }));
    expect(state.lastSinceNano).toBe(1730000000200000000);
  });
});
