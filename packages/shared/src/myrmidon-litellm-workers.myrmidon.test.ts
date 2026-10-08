// packages/shared/src/myrmidon-litellm-workers.myrmidon.test.ts
//
// myrmidon(1.6.6 LITELLM-WORKERS A): the contract the board and the interface
// share — the ceilings a container shape imposes, the target in force, the
// TTIN/TTOU arithmetic and the runtime the instance declares.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LITELLM_WORKERS_CONTAINER,
  DEFAULT_LITELLM_WORKERS_CORES,
  DEFAULT_LITELLM_WORKERS_MEMORY_GB,
  DEFAULT_LITELLM_WORKERS_SIGNAL_COMMAND,
  LITELLM_WORKERS_BASELINE_ENV,
  LITELLM_WORKERS_COMPANIES_KEY,
  LITELLM_WORKERS_CONTAINER_ENV,
  LITELLM_WORKERS_CORES_ENV,
  LITELLM_WORKERS_MEMORY_GB_ENV,
  LITELLM_WORKERS_SIGNAL_COMMAND_ENV,
  checkLitellmWorkersTarget,
  litellmWorkersCeilings,
  litellmWorkersMaxByCpu,
  litellmWorkersMaxByMemory,
  litellmWorkersSignalSteps,
  readLitellmWorkersBaseline,
  readLitellmWorkersRuntime,
  renderLitellmWorkersSignalCommand,
  resolveLitellmWorkersTarget,
} from "./myrmidon-litellm-workers.js";

const shape = (input: Partial<{ cores: number; memoryGb: number; gbPerWorker: number }>) => ({
  cores: 6,
  memoryGb: 12,
  gbPerWorker: 1.5,
  ...input,
});

describe("the ceilings of a container", () => {
  it("names the production shape the ticket describes", () => {
    const ceilings = litellmWorkersCeilings(shape({}));
    expect(ceilings.maxByCpu).toBe(6);
    expect(ceilings.maxByMemory).toBe(8);
    expect(ceilings.maxTarget).toBe(6);
    expect(ceilings.defaultTarget).toBe(5);
  });

  it("counts one worker per core and the memory at 1.5 GB each", () => {
    expect(litellmWorkersMaxByCpu(6)).toBe(6);
    expect(litellmWorkersMaxByMemory(12, 1.5)).toBe(8);
    expect(litellmWorkersMaxByMemory(4, 1.5)).toBe(2);
  });

  it("never answers zero workers or a default above the tighter ceiling", () => {
    expect(litellmWorkersMaxByCpu(1)).toBe(1);
    expect(litellmWorkersMaxByMemory(1, 1.5)).toBe(1);
    const small = litellmWorkersCeilings(shape({ cores: 2, memoryGb: 1.5 }));
    expect(small.maxTarget).toBe(1);
    expect(small.defaultTarget).toBe(1);
  });

  it("falls back to the production numbers on an unreadable shape", () => {
    const ceilings = litellmWorkersCeilings({ cores: Number.NaN, memoryGb: -1, gbPerWorker: 0 });
    expect(ceilings.maxByCpu).toBe(DEFAULT_LITELLM_WORKERS_CORES);
    expect(ceilings.maxByMemory).toBe(Math.floor(DEFAULT_LITELLM_WORKERS_MEMORY_GB / 1.5));
  });
});

describe("the target in force", () => {
  it("prefers the stored target", () => {
    expect(resolveLitellmWorkersTarget({ target: 3, observed: null }, litellmWorkersCeilings(shape({})))).toEqual({
      target: 3,
      source: "settings",
    });
  });

  it("answers the default when nothing is stored", () => {
    expect(resolveLitellmWorkersTarget({ target: null, observed: null }, litellmWorkersCeilings(shape({})))).toEqual({
      target: 5,
      source: "default",
    });
  });

  it("drops a stored target the container can no longer hold", () => {
    // The value was written on a bigger box; the current one could never run it.
    expect(resolveLitellmWorkersTarget({ target: 12, observed: null }, litellmWorkersCeilings(shape({})))).toEqual({
      target: 5,
      source: "default",
    });
  });
});

describe("the signals of a resize", () => {
  it("adds a worker with TTIN and drops one with TTOU", () => {
    expect(litellmWorkersSignalSteps(4, 6)).toEqual([{ signal: "TTIN", count: 2 }]);
    expect(litellmWorkersSignalSteps(6, 4)).toEqual([{ signal: "TTOU", count: 2 }]);
    expect(litellmWorkersSignalSteps(5, 5)).toEqual([]);
  });

  it("answers nothing for a size that is not a number", () => {
    expect(litellmWorkersSignalSteps(Number.NaN, 5)).toEqual([]);
  });

  it("fills the placeholders of the command template", () => {
    expect(renderLitellmWorkersSignalCommand("systemctl kill -s {signal} {container}", { signal: "TTIN", container: "litellm" })).toBe(
      "systemctl kill -s TTIN litellm",
    );
    expect(renderLitellmWorkersSignalCommand("true", { signal: "TTOU", container: "x" })).toBe("true");
  });
});

describe("what the instance declares", () => {
  it("reads the production defaults from an empty environment", () => {
    const runtime = readLitellmWorkersRuntime({});
    expect(runtime.host).toEqual({ cores: 6, memoryGb: 12, gbPerWorker: 1.5 });
    expect(runtime.signal.command).toBe(DEFAULT_LITELLM_WORKERS_SIGNAL_COMMAND);
    expect(runtime.signal.container).toBe(DEFAULT_LITELLM_WORKERS_CONTAINER);
    expect(runtime.signal.source).toBe("default");
    expect(runtime.baseline).toBeNull();
  });

  it("takes the shape, the command and the baseline from the environment", () => {
    const runtime = readLitellmWorkersRuntime({
      [LITELLM_WORKERS_CORES_ENV]: "4",
      [LITELLM_WORKERS_MEMORY_GB_ENV]: "8",
      [LITELLM_WORKERS_SIGNAL_COMMAND_ENV]: "docker kill -s {signal} {container}",
      [LITELLM_WORKERS_CONTAINER_ENV]: "litellm-gateway",
      [LITELLM_WORKERS_BASELINE_ENV]: "4",
    });
    expect(runtime.host).toEqual({ cores: 4, memoryGb: 8, gbPerWorker: 1.5 });
    expect(runtime.hostSource).toEqual({ cores: "env", memoryGb: "env" });
    expect(runtime.signal.source).toBe("env");
    expect(runtime.baseline).toBe(4);
    expect(litellmWorkersCeilings(runtime.host)).toMatchObject({ maxByCpu: 4, maxByMemory: 5, maxTarget: 4, defaultTarget: 3 });
  });

  it("ignores a baseline that is not a whole number of workers", () => {
    expect(readLitellmWorkersBaseline({ [LITELLM_WORKERS_BASELINE_ENV]: "0" })).toBeNull();
    expect(readLitellmWorkersBaseline({ [LITELLM_WORKERS_BASELINE_ENV]: "-2" })).toBeNull();
    expect(readLitellmWorkersBaseline({ [LITELLM_WORKERS_BASELINE_ENV]: "2.5" })).toBeNull();
    expect(readLitellmWorkersBaseline({ [LITELLM_WORKERS_BASELINE_ENV]: " four " })).toBeNull();
    expect(readLitellmWorkersBaseline({})).toBeNull();
  });

  it("keeps the storage key stable", () => {
    expect(LITELLM_WORKERS_COMPANIES_KEY).toBe("myrmidonLitellmWorkersCompanies");
  });
});

describe("a target the route must reject", () => {
  const ceilings = litellmWorkersCeilings(shape({}));

  it("states the memory rule the ticket names", () => {
    expect(checkLitellmWorkersTarget(9, ceilings)).toEqual({
      ok: false,
      reason: "above_memory",
      message: "target 9 exceeds maxByMemory 8",
    });
  });

  it("answers the CPU rule when memory is the looser ceiling", () => {
    expect(checkLitellmWorkersTarget(7, ceilings).reason).toBe("above_cpu");
  });

  it("rejects a target that is not a positive whole number", () => {
    expect(checkLitellmWorkersTarget(0, ceilings).reason).toBe("below_minimum");
    expect(checkLitellmWorkersTarget(-1, ceilings).reason).toBe("below_minimum");
    expect(checkLitellmWorkersTarget(4.5, ceilings).reason).toBe("not_integer");
    expect(checkLitellmWorkersTarget(null, ceilings).reason).toBe("not_integer");
    expect(checkLitellmWorkersTarget("5", ceilings).reason).toBe("not_integer");
  });

  it("passes every target the container can hold", () => {
    for (let target = ceilings.minTarget; target <= ceilings.maxTarget; target += 1) {
      expect(checkLitellmWorkersTarget(target, ceilings).ok).toBe(true);
    }
  });
});