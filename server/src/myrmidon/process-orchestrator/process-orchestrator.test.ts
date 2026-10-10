// server/src/myrmidon/process-orchestrator/process-orchestrator.test.ts
//
// myrmidon(1.6.6 PROCS-T1.5): the launch map guard. Pins three things the
// ticket's acceptance rests on:
//  1. `single` (default) stays byte-for-byte today's board — one entry, no
//     overlays, so the runtime switch living in this directory can be merged
//     while nobody flips it;
//  2. `split` builds N api + M workers with disjoint port blocks and a
//     deterministic queue split of the seven execution-control queues
//     (the OPE-6875 criterion: N=2 + M=2 must be a valid map);
//  3. a misconfigured map (bad count, port collision, shared port without
//     the PROCS-1.2 supervisor) fails as a config error BEFORE anything
//     spawns, and the spawn card (launcher.ts) mirrors the map exactly.
import { describe, expect, it } from "vitest";

import {
  API_COUNT_ENV,
  BOARD_PORT_ENV,
  PROCESSES_MODE_ENV,
  PROCESS_INDEX_ENV,
  PROCESS_ROLE_ENV,
  PARENT_BOOT_ID_ENV,
  EXECUTION_CONTROL_QUEUES,
  WORKER_COUNT_ENV,
  WORKER_HOST_ENV,
  WORKER_PORT_ENV,
  WORKER_QUEUES_ENV,
  API_PORT_STRIDE_ENV,
  ProcessConfigError,
  assignExecutionControlQueues,
  buildProcessMap,
  describeProcessMap,
  exceedsRecommendedWorkerCount,
  parseWorkerQueues,
  resolveProcessMode,
} from "./config.js";
import { buildLaunchPlan, serverPackageRoot } from "./launcher.js";

/** The env of a process started by `pnpm dev:procs`: mode flipped to split,
 * N=2 api + M=2 worker (the ticket criterion), everything else ambient. */
function acceptanceEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [PROCESSES_MODE_ENV]: "split",
    [API_COUNT_ENV]: "2",
    [WORKER_COUNT_ENV]: "2",
    ...extra,
  };
}

describe("resolveProcessMode", () => {
  it("split only on the exact word (case/space tolerant); everything else is single", () => {
    expect(resolveProcessMode("split")).toBe("split");
    expect(resolveProcessMode(" SPLIT ")).toBe("split");
    expect(resolveProcessMode(undefined)).toBe("single");
    expect(resolveProcessMode("")).toBe("single");
    expect(resolveProcessMode("triple")).toBe("single");
    expect(resolveProcessMode("1")).toBe("single");
  });
});

describe("buildProcessMap — single mode", () => {
  it("is today's board: one entry, role all, ambient port, no overlays", () => {
    const map = buildProcessMap({});
    expect(map.mode).toBe("single");
    expect(map.entries).toHaveLength(1);
    const board = map.entries[0]!;
    expect(board.role).toBe("all");
    expect(board.listenPort).toBe(3100);
    expect(board.env).toEqual({});
    expect(board.queues).toEqual([...EXECUTION_CONTROL_QUEUES]);
  });

  it("honours an ambient PORT as the api base", () => {
    const map = buildProcessMap({ [BOARD_PORT_ENV]: "3300" });
    expect(map.entries[0]!.listenPort).toBe(3300);
    expect(map.workerBasePort).toBe(3304);
  });
});

describe("buildProcessMap — split mode", () => {
  it("the ticket criterion: N=2 api + M=2 worker is a valid map", () => {
    const map = buildProcessMap(acceptanceEnv());
    expect(map.mode).toBe("split");
    expect(map.apiCount).toBe(2);
    expect(map.workerCount).toBe(2);

    const workers = map.entries.filter((entry) => entry.role === "worker");
    const apis = map.entries.filter((entry) => entry.role === "api");
    expect(workers.map((entry) => entry.name)).toEqual(["worker-0", "worker-1"]);
    expect(apis.map((entry) => entry.name)).toEqual(["api-0", "api-1"]);

    // Worker block on loopback: 3104/3105 with the stock api port; api block
    // on stride-1 slots 3100/3101. The two blocks must not touch.
    expect(workers.map((entry) => entry.listenPort)).toEqual([3104, 3105]);
    expect(apis.map((entry) => entry.listenPort)).toEqual([3100, 3101]);
    expect(apis.map((entry) => entry.apiPort)).toEqual([3100, 3100]);
    expect(workers.every((entry) => entry.host === "127.0.0.1")).toBe(true);

    // Queue split: seven queues over two workers, deterministic 4+3, every
    // queue owned exactly once, api owns none.
    const owned = workers.flatMap((entry) => entry.queues);
    expect(owned.sort()).toEqual([...EXECUTION_CONTROL_QUEUES].sort());
    expect(workers[0]!.queues).toHaveLength(4);
    expect(workers[1]!.queues).toHaveLength(3);
    expect(apis.every((entry) => entry.queues.length === 0)).toBe(true);

    // Design rule: M=2 exceeds the stage-1 recommendation and must be
    // flaggable by the launcher (warning, not error).
    expect(exceedsRecommendedWorkerCount(map)).toBe(true);
  });

  it("writes the role contract into every child env", () => {
    const map = buildProcessMap(acceptanceEnv({ [BOARD_PORT_ENV]: "4000" }));
    for (const entry of map.entries) {
      expect(entry.env[PROCESS_ROLE_ENV]).toBe(entry.role);
      expect(entry.env[PROCESSES_MODE_ENV]).toBe("split");
      expect(entry.env[PROCESS_INDEX_ENV]).toBe(String(entry.index));
    }
    const worker0 = map.entries[0]!;
    expect(worker0.env[BOARD_PORT_ENV]).toBe(String(worker0.listenPort));
    expect(worker0.env[WORKER_QUEUES_ENV]).toBe(worker0.queues.join(","));
    // The api child binds its own slot and dials the worker block base.
    const api1 = map.entries.find((entry) => entry.name === "api-1")!;
    expect(api1.env[BOARD_PORT_ENV]).toBe("4001");
    expect(api1.env[WORKER_PORT_ENV]).toBe("4004");
    expect(api1.env[WORKER_HOST_ENV]).toBe("127.0.0.1");
  });

  it("worker port override moves the whole worker block", () => {
    const map = buildProcessMap(acceptanceEnv({ [WORKER_PORT_ENV]: "3200" }));
    expect(map.entries.filter((e) => e.role === "worker").map((e) => e.listenPort))
      .toEqual([3200, 3201]);
  });

  it("M=1 keeps the production shape: the single worker sweeps all queues", () => {
    const map = buildProcessMap({
      [PROCESSES_MODE_ENV]: "split",
      [API_COUNT_ENV]: "1",
      [WORKER_COUNT_ENV]: "1",
    });
    expect(map.entries.filter((e) => e.role === "worker")[0]!.queues)
      .toEqual([...EXECUTION_CONTROL_QUEUES]);
    expect(exceedsRecommendedWorkerCount(map)).toBe(false);
  });

  it("rejects the shared-port shape until PROCS-1.2 (stride 0 with N>1)", () => {
    expect(() =>
      buildProcessMap(acceptanceEnv({ [API_PORT_STRIDE_ENV]: "0" })),
    ).toThrow(ProcessConfigError);
    // stride 0 with a single api is the ordinary single-listener case.
    const map = buildProcessMap({
      [PROCESSES_MODE_ENV]: "split",
      [API_COUNT_ENV]: "1",
      [API_PORT_STRIDE_ENV]: "0",
    });
    expect(map.entries.find((e) => e.role === "api")!.listenPort).toBe(3100);
  });

  it("rejects a port collision between the blocks", () => {
    expect(() =>
      buildProcessMap({
        [PROCESSES_MODE_ENV]: "split",
        [WORKER_PORT_ENV]: "3101",
      }),
    ).toThrow(/collides/);
  });

  it("rejects out-of-range counts and junk env values as config errors", () => {
    expect(() => buildProcessMap(acceptanceEnv({ [API_COUNT_ENV]: "5" })))
      .toThrow(/between 1 and 4/);
    expect(() => buildProcessMap(acceptanceEnv({ [API_COUNT_ENV]: "two" })))
      .toThrow(ProcessConfigError);
    expect(() => buildProcessMap(acceptanceEnv({ [WORKER_COUNT_ENV]: "3" })))
      .toThrow(ProcessConfigError);
    expect(() => buildProcessMap(acceptanceEnv({ [BOARD_PORT_ENV]: "80" })))
      .toThrow(/between 1024 and 65535/);
  });
});

describe("parseWorkerQueues", () => {
  it("empty/unset means all queues (the single-worker shape)", () => {
    expect(parseWorkerQueues(undefined)).toEqual([...EXECUTION_CONTROL_QUEUES]);
    expect(parseWorkerQueues("  ")).toEqual([...EXECUTION_CONTROL_QUEUES]);
  });

  it("keeps the listed names in order, deduped; a typo is an error", () => {
    expect(parseWorkerQueues("run_stall, finalization")).toEqual(["run_stall", "finalization"]);
    expect(parseWorkerQueues("finalization,finalization")).toEqual(["finalization"]);
    expect(() => parseWorkerQueues("finallization")).toThrow(/unknown execution-control queue/);
  });
});

describe("assignExecutionControlQueues", () => {
  it("is deterministic and covers every queue exactly once for each M", () => {
    for (const count of [1, 2]) {
      const buckets = assignExecutionControlQueues(count);
      expect(buckets).toHaveLength(count);
      expect(buckets.flat().sort()).toEqual([...EXECUTION_CONTROL_QUEUES].sort());
      expect(new Set(buckets.flat()).size).toBe(EXECUTION_CONTROL_QUEUES.length);
      // deterministic: same call, same answer
      expect(assignExecutionControlQueues(count)).toEqual(buckets);
    }
  });
});

describe("buildLaunchPlan — the spawn card", () => {
  const map = buildProcessMap(acceptanceEnv());
  const plan = buildLaunchPlan(map, { bootId: "parent-boot-1", tsxCliPath: "/fake/tsx/cli.mjs" });

  it("mirrors the map: one spec per entry, workers first, health URL per slot", () => {
    expect(plan.specs.map((s) => s.name)).toEqual(["worker-0", "worker-1", "api-0", "api-1"]);
    // Non-watch (supervisor-shaped) plan runs the entrypoint directly.
    expect(plan.specs.every((s) => s.args[s.args.length - 1] === "src/index.ts")).toBe(true);
    expect(plan.specs.every((s) => s.cwd === serverPackageRoot())).toBe(true);
    expect(plan.specs.map((s) => s.healthUrl)).toEqual([
      "http://127.0.0.1:3104/api/health",
      "http://127.0.0.1:3105/api/health",
      "http://127.0.0.1:3100/api/health",
      "http://127.0.0.1:3101/api/health",
    ]);
  });

  it("carries the map overlay plus the parent bootId into each child", () => {
    for (const spec of plan.specs) {
      expect(spec.env[PARENT_BOOT_ID_ENV]).toBe("parent-boot-1");
    }
    expect(plan.specs[0]!.env[WORKER_QUEUES_ENV]).toBe(map.entries[0]!.queues.join(","));
    expect(plan.specs[0]!.env[PROCESS_ROLE_ENV]).toBe("worker");
    expect(plan.specs[2]!.env[PROCESS_ROLE_ENV]).toBe("api");
  });

  it("watch mode routes every entry through the dev-watch wrapper", () => {
    const watched = buildLaunchPlan(map, { watch: true, tsxCliPath: "/fake/tsx/cli.mjs" });
    // dev-watch.ts is itself the `tsx watch` wrapper `pnpm dev` uses, so the
    // ignore set stays in one place; the launcher only picks the entry.
    expect(watched.specs[0]!.args).toEqual(["/fake/tsx/cli.mjs", "scripts/dev-watch.ts"]);
    expect(plan.specs[0]!.args).not.toEqual(watched.specs[0]!.args);
  });
});

describe("describeProcessMap", () => {
  it("prints one line per entry of the acceptance map", () => {
    const lines = describeProcessMap(buildProcessMap(acceptanceEnv()));
    expect(lines).toHaveLength(4);
    expect(lines.some((line) => line.startsWith("worker-0"))).toBe(true);
    expect(lines.some((line) => line.includes("dials 127.0.0.1:3104"))).toBe(true);
  });
});
