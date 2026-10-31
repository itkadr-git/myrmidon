import { describe, expect, it, vi } from "vitest";

vi.mock("../../services/index.js", () => ({ heartbeatService: vi.fn() }));

const { maintenanceHeartbeatPort } = await import("./index.js");

type Heartbeat = Parameters<typeof maintenanceHeartbeatPort>[0];

function port(scheduleBoundedRetry: ReturnType<typeof vi.fn>) {
  const heartbeat = {
    cancelRun: vi.fn().mockResolvedValue({ status: "cancelled" }),
    scheduleBoundedRetry,
  };
  return { heartbeat, port: maintenanceHeartbeatPort(heartbeat as unknown as Heartbeat) };
}

describe("maintenance interrupt retry claim", () => {
  it("repeats the retry claim when Postgres picks it as the deadlock victim", async () => {
    const deadlock = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });
    const schedule = vi.fn().mockRejectedValueOnce(deadlock).mockResolvedValue({ outcome: "scheduled" });
    const { heartbeat, port: p } = port(schedule);

    await expect(p.interruptRunForMaintenance!("run-1", "window-1")).resolves.toEqual({ retryScheduled: true });
    expect(heartbeat.cancelRun).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the claim for other failures", async () => {
    const schedule = vi.fn().mockRejectedValue(new Error("connection lost"));
    const { port: p } = port(schedule);

    await expect(p.interruptRunForMaintenance!("run-1", "window-1")).rejects.toThrow("connection lost");
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
