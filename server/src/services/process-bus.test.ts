// myrmidon(PROCS-1.3): unit tests for the process bus (design OPE-5394 §3).
// A fake `ProcessBusSql` plays Postgres: it routes `pg_notify` payloads to the
// registered listeners, can drop one (the T6 lost-NOTIFY case), and replays
// `onlisten` the way postgres.js does on a reconnect.

import { describe, expect, it } from "vitest";
import {
  PROCESS_BUS_MAX_PAYLOAD_BYTES,
  PROCESS_BUS_SCHEMA_VERSION,
  ProcessBus,
  ProcessBusPayloadTooLargeError,
  processBusChannelName,
  type ProcessBusSql,
} from "./process-bus.js";

type NotifyFn = (payload: string) => void;

class FakeSql implements ProcessBusSql {
  listeners = new Map<string, { onnotify: NotifyFn; onlisten?: () => void }>();
  published: { channel: string; payload: string }[] = [];
  dropped = 0;

  async listen(channel: string, onnotify: NotifyFn, onlisten?: () => void) {
    this.listeners.set(channel, { onnotify, onlisten });
    onlisten?.();
    return {
      unlisten: async () => {
        this.listeners.delete(channel);
      },
    };
  }

  async unsafe(query: string, parameters?: unknown[]) {
    expect(query).toBe("select pg_notify($1, $2)");
    const [channel, payload] = parameters as [string, string];
    this.published.push({ channel, payload });
  }

  /** Deliver the last published payload of a channel to its listeners. */
  deliver(channel: string) {
    const entry = this.published.filter((p) => p.channel === channel).at(-1);
    if (!entry) throw new Error(`nothing published on ${channel}`);
    this.listeners.get(channel)?.onnotify(entry.payload);
  }

  /** A NOTIFY that never arrives: the payload is published but not delivered. */
  drop(channel: string) {
    const entry = this.published.filter((p) => p.channel === channel).at(-1);
    if (!entry) throw new Error(`nothing published on ${channel}`);
    this.dropped += 1;
  }

  /** postgres.js re-LISTENs and calls `onlisten` again after a reconnect. */
  reconnect() {
    for (const listener of this.listeners.values()) listener.onlisten?.();
  }
}

function foreignEnvelope(origin: string, payload: unknown, schemaVersion = PROCESS_BUS_SCHEMA_VERSION) {
  return JSON.stringify({ schemaVersion, origin, channel: "run_queued", payload, sentAt: "2026-10-08T00:00:00Z" });
}

describe("process bus", () => {
  it("delivers a published message to a subscriber on the same channel", async () => {
    const sql = new FakeSql();
    const bus = new ProcessBus(sql, { bootId: "boot-a" });
    const seen: unknown[] = [];
    bus.subscribe<{ agentId: string }>("run_queued", (payload) => seen.push(payload));
    await bus.start();
    // A message published by another process arrives over the listen connection.
    sql.listeners.get(processBusChannelName("run_queued"))?.onnotify(foreignEnvelope("boot-b", { agentId: "agent-1" }));
    expect(seen).toEqual([{ agentId: "agent-1" }]);
  });

  it("origin filter: a process drops its own message", async () => {
    const sql = new FakeSql();
    const bus = new ProcessBus(sql, { bootId: "boot-a" });
    const seen: unknown[] = [];
    bus.subscribe("run_queued", (payload) => seen.push(payload));
    await bus.start();
    // The bus publishes with origin = its bootId; the same payload coming back
    // on the listen connection must not reach the handler.
    await bus.publish("run_queued", { agentId: "agent-1" });
    sql.deliver(processBusChannelName("run_queued"));
    expect(seen).toEqual([]);
    // A message from another boot id is delivered.
    sql.listeners.get(processBusChannelName("run_queued"))?.onnotify(foreignEnvelope("boot-b", { agentId: "agent-2" }));
    expect(seen).toEqual([{ agentId: "agent-2" }]);
  });

  it("reconnect dogon: onlisten fires again after a reconnect and runs the onReconnect handlers", async () => {
    const sql = new FakeSql();
    const bus = new ProcessBus(sql, { bootId: "boot-a" });
    let resweeps = 0;
    bus.subscribe("settings_changed", () => {});
    bus.onReconnect(() => {
      resweeps += 1;
    });
    await bus.start();
    expect(resweeps).toBe(1); // the initial listen is also a (re)listen
    sql.reconnect();
    expect(resweeps).toBe(2);
  });

  it("refuses a payload above the 8000-byte NOTIFY limit and sends nothing", async () => {
    const sql = new FakeSql();
    const bus = new ProcessBus(sql, { bootId: "boot-a" });
    const big = "x".repeat(PROCESS_BUS_MAX_PAYLOAD_BYTES);
    await expect(bus.publish("live_event", { data: big })).rejects.toBeInstanceOf(
      ProcessBusPayloadTooLargeError,
    );
    expect(sql.published).toEqual([]);
  });

  it("stamps schemaVersion on every message and drops a foreign schemaVersion", async () => {
    const sql = new FakeSql();
    const bus = new ProcessBus(sql, { bootId: "boot-a" });
    const seen: unknown[] = [];
    bus.subscribe("run_queued", (payload) => seen.push(payload));
    await bus.start();
    await bus.publish("run_queued", { agentId: "agent-1" });
    const raw = JSON.parse(sql.published[0].payload) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(PROCESS_BUS_SCHEMA_VERSION);
    expect(raw.origin).toBe("boot-a");
    expect(raw.channel).toBe("run_queued");
    expect(typeof raw.sentAt).toBe("string");
    // A message with a different schemaVersion (deploy skew) is dropped.
    sql.listeners.get(processBusChannelName("run_queued"))?.onnotify(
      foreignEnvelope("boot-b", { agentId: "agent-2" }, PROCESS_BUS_SCHEMA_VERSION + 1),
    );
    expect(seen).toEqual([]);
  });

  it("drops a malformed payload without calling the handler", async () => {
    const sql = new FakeSql();
    const bus = new ProcessBus(sql, { bootId: "boot-a" });
    const seen: unknown[] = [];
    bus.subscribe("run_queued", (payload) => seen.push(payload));
    await bus.start();
    sql.listeners.get(processBusChannelName("run_queued"))?.onnotify("not json");
    sql.listeners.get(processBusChannelName("run_queued"))?.onnotify(JSON.stringify({ no: "envelope" }));
    expect(seen).toEqual([]);
  });

  // T6: a lost NOTIFY must not lose the work. The bus carries no correctness:
  // a periodic fallback sweep re-reads the state and picks up what the lost
  // signal skipped. The test publishes a run_queued that never arrives, then
  // runs the fallback sweep and asserts the queued run is picked up anyway.
  it("T6: a lost NOTIFY is picked up by the periodic fallback sweep", async () => {
    const sql = new FakeSql();
    const bus = new ProcessBus(sql, { bootId: "boot-a" });

    // The worker-side state this test fakes: a queue of runs and the two ways
    // a run leaves it — the fast NOTIFY path and the periodic sweep.
    const queue: string[] = [];
    const started: string[] = [];
    const startNextQueuedRunForAgent = (agentId: string) => {
      const index = queue.indexOf(agentId);
      if (index >= 0) {
        queue.splice(index, 1);
        started.push(agentId);
      }
    };
    const resweepQueuedWithoutRunning = () => {
      for (const agentId of [...queue]) startNextQueuedRunForAgent(agentId);
    };

    bus.subscribe<{ agentId: string }>("run_queued", (payload) => startNextQueuedRunForAgent(payload.agentId));
    await bus.start();

    // A run queued on process A; its NOTIFY is lost (listener down).
    queue.push("agent-1");
    await bus.publish("run_queued", { agentId: "agent-1" });
    sql.drop(processBusChannelName("run_queued"));
    expect(started).toEqual([]); // the signal really was lost

    // The periodic fallback sweep picks it up; no work is lost.
    resweepQueuedWithoutRunning();
    expect(started).toEqual(["agent-1"]);
    expect(queue).toEqual([]);

    // And a delivered NOTIFY still takes the fast path (no double start).
    queue.push("agent-2");
    sql.listeners.get(processBusChannelName("run_queued"))?.onnotify(foreignEnvelope("boot-b", { agentId: "agent-2" }));
    expect(started).toEqual(["agent-1", "agent-2"]);
    resweepQueuedWithoutRunning();
    expect(started).toEqual(["agent-1", "agent-2"]);
  });
});
