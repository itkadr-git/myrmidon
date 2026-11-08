// packages/shared/src/myrmidon-litellm-workers.myrmidon.test.ts
//
// myrmidon(1.6.6 LITELLM-WORKERS restart): the contract the board and the interface
// share — the ceilings a container shape imposes, the target in force, the
// restart command and the runtime the instance declares.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LITELLM_WORKERS_CORES,
  DEFAULT_LITELLM_WORKERS_MEMORY_GB,
  DEFAULT_LITELLM_WORKERS_UNIT_FILE,
  LITELLM_WORKERS_BASELINE_ENV,
  LITELLM_WORKERS_COMPANIES_KEY,
  LITELLM_WORKERS_CORES_ENV,
  LITELLM_WORKERS_MEMORY_GB_ENV,
  LITELLM_WORKERS_RESTART_COMMAND_ENV,
  LITELLM_WORKERS_UNIT_FILE_ENV,
  checkLitellmWorkersTarget,
  litellmWorkersCeilings,
  litellmWorkersMaxByCpu,
  litellmWorkersMaxByMemory,
  parseLitellmWorkersFromCommandLine,
  readLitellmWorkersBaseline,
  readLitellmWorkersRuntime,
  renderLitellmWorkersRestartCommand,
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

describe("the restart of a resize", () => {
  it("fills the target into the command template", () => {
    expect(renderLitellmWorkersRestartCommand("set-workers {workers} && restart", 3)).toBe("set-workers 3 && restart");
    expect(renderLitellmWorkersRestartCommand("true", 3)).toBe("true");
  });

  it("reads the pool the launch line declares", () => {
    expect(parseLitellmWorkersFromCommandLine("    --config /app/config.yaml --port 4000 --num_workers 2")).toBe(2);
    expect(parseLitellmWorkersFromCommandLine("litellm --num_workers=6")).toBe(6);
    expect(parseLitellmWorkersFromCommandLine("# --num_workers 9\nlitellm --num_workers 3")).toBe(3);
  });

  it("answers null when the launch line declares no usable number", () => {
    expect(parseLitellmWorkersFromCommandLine("litellm --port 4000")).toBeNull();
    expect(parseLitellmWorkersFromCommandLine("litellm --num_workers 0")).toBeNull();
    expect(parseLitellmWorkersFromCommandLine("")).toBeNull();
  });
});

describe("what the instance declares", () => {
  it("reads the production defaults from an empty environment", () => {
    const runtime = readLitellmWorkersRuntime({});
    expect(runtime.host).toEqual({ cores: 6, memoryGb: 12, gbPerWorker: 1.5 });
    // Nothing is ever restarted by default.
    expect(runtime.restart.command).toBeNull();
    expect(runtime.unitFile).toBe(DEFAULT_LITELLM_WORKERS_UNIT_FILE);
    expect(runtime.baseline).toBeNull();
  });

  it("takes the shape, the command and the baseline from the environment", () => {
    const runtime = readLitellmWorkersRuntime({
      [LITELLM_WORKERS_CORES_ENV]: "4",
      [LITELLM_WORKERS_MEMORY_GB_ENV]: "8",
      [LITELLM_WORKERS_RESTART_COMMAND_ENV]: "set-workers {workers}",
      [LITELLM_WORKERS_UNIT_FILE_ENV]: "/srv/litellm.service",
      [LITELLM_WORKERS_BASELINE_ENV]: "4",
    });
    expect(runtime.host).toEqual({ cores: 4, memoryGb: 8, gbPerWorker: 1.5 });
    expect(runtime.hostSource).toEqual({ cores: "env", memoryGb: "env" });
    expect(runtime.restart.command).toBe("set-workers {workers}");
    expect(runtime.unitFile).toBe("/srv/litellm.service");
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