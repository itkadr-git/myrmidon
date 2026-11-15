import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeProgressReporter, withSilenceHeartbeat } from "./runtime-progress.js";

const MB = 1024 * 1024;

function makeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("createRuntimeProgressReporter", () => {
  it("formats the message with phase, label, direction, target, percent and MB", async () => {
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "sandbox",
    });

    await reporter.report(12.6 * MB, 31.4 * MB);

    expect(lines).toEqual(["[paperclip] Syncing workspace to environment: 40% (12.6/31.4 MB)\n"]);
  });

  it("omits the label when none is provided (e.g. git history)", async () => {
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Importing git history",
      direction: "to",
      target: "ssh",
    });

    await reporter.report(4 * MB, 4 * MB);

    expect(lines).toEqual(["[paperclip] Importing git history to ssh: 100% (4.0/4.0 MB)\n"]);
  });

  it("suppresses intermediate emits that neither cross a step nor exceed the interval", async () => {
    const clock = makeClock();
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "sandbox",
      now: clock.now,
    });

    // First report always emits (step 0 crossed).
    await reporter.report(1 * MB, 100 * MB); // 1%
    // Still within the same 10% step and under 2s -> suppressed.
    await reporter.report(2 * MB, 100 * MB); // 2%
    await reporter.report(5 * MB, 100 * MB); // 5%

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[paperclip] Syncing workspace to environment: 1% (1.0/100.0 MB)\n");
  });

  it("emits when the percentage crosses a 10% step", async () => {
    const clock = makeClock();
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "sandbox",
      now: clock.now,
    });

    await reporter.report(1 * MB, 100 * MB); // 1% -> emit (step 0)
    await reporter.report(15 * MB, 100 * MB); // 15% -> crosses into step 1 -> emit

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("[paperclip] Syncing workspace to environment: 15% (15.0/100.0 MB)\n");
  });

  it("emits on the time threshold even without a step crossing", async () => {
    const clock = makeClock();
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "sandbox",
      now: clock.now,
    });

    await reporter.report(1 * MB, 100 * MB); // emit
    await reporter.report(2 * MB, 100 * MB); // suppressed (same step, no time elapsed)
    clock.advance(2000);
    await reporter.report(3 * MB, 100 * MB); // 3% same step, but 2s elapsed -> emit

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("[paperclip] Syncing workspace to environment: 3% (3.0/100.0 MB)\n");
  });

  it("always emits the terminal 100% line via report reaching the total", async () => {
    const clock = makeClock();
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Restoring",
      label: "workspace",
      direction: "from",
      target: "sandbox",
      now: clock.now,
    });

    await reporter.report(1 * MB, 100 * MB); // emit
    await reporter.report(100 * MB, 100 * MB); // terminal -> always emit

    expect(lines[lines.length - 1]).toBe(
      "[paperclip] Restoring workspace from environment: 100% (100.0/100.0 MB)\n",
    );
  });

  it("complete() emits the terminal 100% line even when intermediate emits were throttled", async () => {
    const clock = makeClock();
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "sandbox",
      now: clock.now,
    });

    await reporter.report(1 * MB, 100 * MB); // emit
    await reporter.report(5 * MB, 100 * MB); // suppressed
    await reporter.complete();

    expect(lines[lines.length - 1]).toBe(
      "[paperclip] Syncing workspace to environment: 100% (100.0/100.0 MB)\n",
    );
  });

  it("complete() is idempotent and does not double-emit after a terminal report", async () => {
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "sandbox",
    });

    await reporter.report(100 * MB, 100 * MB); // terminal
    await reporter.complete();
    await reporter.complete();

    expect(lines).toHaveLength(1);
  });

  it("reports MB-only (no percent) when the total is unknown, plus a completion line", async () => {
    const clock = makeClock();
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Restoring",
      label: "workspace",
      direction: "from",
      target: "ssh",
      now: clock.now,
    });

    await reporter.report(2 * MB, null); // first emit
    await reporter.report(4 * MB, null); // suppressed (no time elapsed)
    clock.advance(2000);
    await reporter.report(8 * MB, null); // time elapsed -> emit
    await reporter.complete();

    expect(lines).toEqual([
      "[paperclip] Restoring workspace from ssh: 2.0 MB\n",
      "[paperclip] Restoring workspace from ssh: 8.0 MB\n",
      "[paperclip] Restoring workspace from ssh: 8.0 MB\n",
    ]);
  });

  it("fail() emits a terminal failure marker with the last percent instead of a dangling line", async () => {
    const clock = makeClock();
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "ssh",
      now: clock.now,
    });

    await reporter.report(40 * MB, 100 * MB); // emit at 40%
    await reporter.fail();

    expect(lines).toEqual([
      "[paperclip] Syncing workspace to ssh: 40% (40.0/100.0 MB)\n",
      "[paperclip] Syncing workspace to ssh: failed at 40% (40.0/100.0 MB)\n",
    ]);
  });

  it("fail() falls back to an MB marker when the total is unknown", async () => {
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Restoring",
      direction: "from",
      target: "ssh",
    });

    await reporter.report(3 * MB, null);
    await reporter.fail();

    expect(lines.at(-1)).toBe("[paperclip] Restoring from ssh: failed after 3.0 MB\n");
  });

  it("fail() is suppressed after a terminal completion and complete() after a failure", async () => {
    const lines: string[] = [];
    const reporter = createRuntimeProgressReporter({
      sink: (line) => {
        lines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "ssh",
    });

    await reporter.report(100 * MB, 100 * MB); // terminal complete
    await reporter.fail(); // suppressed — already completed
    expect(lines).toHaveLength(1);

    const failLines: string[] = [];
    const failed = createRuntimeProgressReporter({
      sink: (line) => {
        failLines.push(line);
      },
      phase: "Syncing",
      label: "workspace",
      direction: "to",
      target: "ssh",
    });
    await failed.report(20 * MB, 100 * MB);
    await failed.fail();
    await failed.complete(); // suppressed — already failed
    expect(failLines).toHaveLength(2);
    expect(failLines.at(-1)).toContain("failed at 20%");
  });
});

// myrmidon(OPE-12801)
describe("withSilenceHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a pulse line for every silent interval while the work is pending and stops when it ends", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let finish: (value: string) => void = () => {};

    const pending = withSilenceHeartbeat(
      { sink: (line) => { lines.push(line); }, label: "Preparing workspace for ssh", intervalMs: 60_000 },
      () => new Promise<string>((resolve) => { finish = resolve; }),
    );

    await vi.advanceTimersByTimeAsync(59_000);
    expect(lines).toEqual([]);

    await vi.advanceTimersByTimeAsync(121_000);
    expect(lines).toEqual([
      "[paperclip] Preparing workspace for ssh: still working (60s)\n",
      "[paperclip] Preparing workspace for ssh: still working (120s)\n",
      "[paperclip] Preparing workspace for ssh: still working (180s)\n",
    ]);

    finish("done");
    await expect(pending).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(lines).toHaveLength(3);
  });

  it("stays quiet while the work itself reports progress", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let finish: () => void = () => {};

    const pending = withSilenceHeartbeat(
      { sink: (line) => { lines.push(line); }, label: "Restoring workspace from ssh", intervalMs: 60_000 },
      async (sink) => {
        const ticker = setInterval(() => { void sink?.("progress\n"); }, 30_000);
        await new Promise<void>((resolve) => { finish = resolve; });
        clearInterval(ticker);
      },
    );

    await vi.advanceTimersByTimeAsync(300_000);
    finish();
    await pending;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line === "progress\n")).toBe(true);
  });

  it("stops pulsing after maxDurationMs so a real hang still goes silent", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let finish: () => void = () => {};

    const pending = withSilenceHeartbeat(
      { sink: (line) => { lines.push(line); }, label: "Phase", intervalMs: 60_000, maxDurationMs: 180_000 },
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(lines).toHaveLength(3);
    finish();
    await pending;
  });

  it("runs the work without a sink and clears the timer when the work throws", async () => {
    vi.useFakeTimers();
    await expect(withSilenceHeartbeat({ sink: undefined, label: "Phase" }, async (sink) => sink)).resolves.toBeUndefined();

    const lines: string[] = [];
    await expect(
      withSilenceHeartbeat({ sink: (line) => { lines.push(line); }, label: "Phase" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
