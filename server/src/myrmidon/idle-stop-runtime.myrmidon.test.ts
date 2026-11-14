import { describe, expect, it } from "vitest";
import { idleStopRuntimeFromStatus } from "./idle-stop-runtime.js";
import { patchIdleStopBotModesSchema } from "@myrmidon/shared";

describe("idleStopRuntimeFromStatus", () => {
  it("reads the last stop and start from the container inspect", () => {
    const runtime = idleStopRuntimeFromStatus({
      botKey: "b",
      state: "stopped",
      idleStopped: true,
      inspect: { State: { StartedAt: "2026-10-20T01:00:00.000Z", FinishedAt: "2026-10-20T02:00:00.000Z" } },
    });
    expect(runtime.idleStopped).toBe(true);
    expect(runtime.lastStartedAt?.toISOString()).toBe("2026-10-20T01:00:00.000Z");
    expect(runtime.lastStoppedAt?.toISOString()).toBe("2026-10-20T02:00:00.000Z");
  });

  it("computes the cold-start duration when the start follows the stop", () => {
    const runtime = idleStopRuntimeFromStatus({
      botKey: "b",
      state: "running",
      inspect: { State: { StartedAt: "2026-10-20T02:01:35.500Z", FinishedAt: "2026-10-20T02:00:00.000Z" } },
    });
    expect(runtime.coldStartDurationMs).toBe(95_500);
  });

  it("leaves the cold-start duration null when the start is not after the stop", () => {
    const equal = idleStopRuntimeFromStatus({
      botKey: "b",
      state: "stopped",
      inspect: { State: { StartedAt: "2026-10-20T02:00:00.000Z", FinishedAt: "2026-10-20T02:00:00.000Z" } },
    });
    const before = idleStopRuntimeFromStatus({
      botKey: "b",
      state: "stopped",
      inspect: { State: { StartedAt: "2026-10-20T01:00:00.000Z", FinishedAt: "2026-10-20T02:00:00.000Z" } },
    });
    expect(equal.coldStartDurationMs).toBeNull();
    expect(before.coldStartDurationMs).toBeNull();
  });

  it("leaves the cold-start duration null when either timestamp is missing", () => {
    const noStop = idleStopRuntimeFromStatus({
      botKey: "b",
      state: "running",
      inspect: { State: { StartedAt: "2026-10-20T01:00:00.000Z", FinishedAt: "0001-01-01T00:00:00Z" } },
    });
    const noInspect = idleStopRuntimeFromStatus({ botKey: "b", state: "missing" });
    expect(noStop.coldStartDurationMs).toBeNull();
    expect(noInspect.coldStartDurationMs).toBeNull();
  });

  it("reads docker's zero time and a missing inspect as never", () => {
    const zero = idleStopRuntimeFromStatus({
      botKey: "b",
      state: "running",
      inspect: { State: { StartedAt: "2026-10-20T01:00:00.000Z", FinishedAt: "0001-01-01T00:00:00Z" } },
    });
    expect(zero.lastStoppedAt).toBeNull();
    expect(zero.idleStopped).toBe(false);
    expect(idleStopRuntimeFromStatus({ botKey: "b", state: "missing" })).toEqual({
      idleStopped: false,
      lastStoppedAt: null,
      lastStartedAt: null,
      coldStartDurationMs: null,
    });
  });
});

describe("patchIdleStopBotModesSchema", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";

  it("accepts a mode for a list of bots", () => {
    expect(patchIdleStopBotModesSchema.safeParse({ agentIds: [id], mode: "always_on" }).success).toBe(true);
  });

  it("rejects an empty list, a bad id and an unknown mode", () => {
    expect(patchIdleStopBotModesSchema.safeParse({ agentIds: [], mode: "always_on" }).success).toBe(false);
    expect(patchIdleStopBotModesSchema.safeParse({ agentIds: ["x"], mode: "always_on" }).success).toBe(false);
    expect(patchIdleStopBotModesSchema.safeParse({ agentIds: [id], mode: "never" }).success).toBe(false);
  });
});
