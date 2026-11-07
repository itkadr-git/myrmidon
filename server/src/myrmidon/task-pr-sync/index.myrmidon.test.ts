import { afterEach, describe, expect, it, vi } from "vitest";

const sweep = vi.fn(() => ({ sweep: vi.fn(async () => ({ settled: 0, returned: 0 })) }));

vi.mock("./sweep.js", () => ({
  createTaskPrSyncSweep: sweep,
}));
vi.mock("./settings.js", () => ({
  readTaskPrSyncSettings: () => ({ pollMs: 1_000 }),
}));
vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

describe("task PR sync scheduler lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("stops its interval so shutdown cannot start another sweep", async () => {
    vi.useFakeTimers();
    const track = vi.fn((work: Promise<unknown>) => void work);
    const { createTaskPrSyncScheduler } = await import("./index.js");
    const runner = createTaskPrSyncScheduler({
      db: {} as never,
      track,
      isLeader: () => true,
    });
    const sweepRun = sweep.mock.results[0]?.value.sweep as ReturnType<typeof vi.fn>;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepRun).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);

    runner.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sweepRun).toHaveBeenCalledTimes(1);
  });
});
