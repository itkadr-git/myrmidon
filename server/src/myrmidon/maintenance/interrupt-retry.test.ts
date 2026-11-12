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
    expect(heartbeat.cancelRun).toHaveBeenCalledWith(
      "run-1",
      expect.any(String),
      expect.objectContaining({
        errorCode: "myrmidon_maintenance_interrupted",
        resultJson: {
          myrmidonMaintenance: { windowId: "window-1" },
          failedBeforeModel: true,
          failed_before_model: true,
        },
      }),
    );
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the claim for other failures", async () => {
    const schedule = vi.fn().mockRejectedValue(new Error("connection lost"));
    const { port: p } = port(schedule);

    await expect(p.interruptRunForMaintenance!("run-1", "window-1")).rejects.toThrow("connection lost");
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  // myrmidon(OPE-12802): the retry must carry the "continue, do not restart" instruction.
  it("hands the retry an instruction to continue from the interrupted run", async () => {
    const schedule = vi.fn().mockResolvedValue({ outcome: "scheduled" });
    const cancelRun = vi.fn().mockResolvedValue({ status: "cancelled", lastUsefulActionAt: new Date("2026-11-12T01:50:00.000Z") });
    const p = maintenanceHeartbeatPort({ cancelRun, scheduleBoundedRetry: schedule } as unknown as Heartbeat);

    await p.interruptRunForMaintenance!("run-7", "window-9");

    expect(schedule).toHaveBeenCalledWith(
      "run-7",
      expect.objectContaining({
        retryReason: "myrmidon_maintenance",
        wakeReason: "myrmidon_maintenance_retry",
        livenessContinuationState: "maintenance_interrupt_retry",
        livenessContinuationInstruction: expect.stringContaining("run-7"),
      }),
    );
    const opts = schedule.mock.calls[0]![1] as { livenessContinuationInstruction: string };
    expect(opts.livenessContinuationInstruction).toContain("window-9");
    expect(opts.livenessContinuationInstruction).toContain("2026-11-12T01:50:00.000Z");
    expect(opts.livenessContinuationInstruction).toContain("Не начинай заново");
  });
});
