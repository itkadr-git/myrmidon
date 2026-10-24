// myrmidon(OPE-9107): a double SIGTERM closes the resources once.

import { describe, expect, it, vi } from "vitest";
import { createIdempotentShutdown } from "./shutdown-once.js";

describe("createIdempotentShutdown", () => {
  it("runs the shutdown once for two signals and exits for the signal callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = vi.fn(async () => { await gate; });
    const exit = vi.fn();
    const joined = vi.fn();
    const shutdown = createIdempotentShutdown(run, exit, joined);
    const a = shutdown("SIGTERM", true);
    const b = shutdown("SIGTERM", true);
    release();
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(joined).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(true);
  });

  it("a programmatic close followed by a signal still closes once, and only the signal exits", async () => {
    const run = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createIdempotentShutdown(run, exit);
    await shutdown("SIGTERM", false);
    await shutdown("SIGTERM", true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[false], [true]]);
  });
});
