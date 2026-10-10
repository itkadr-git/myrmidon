// server/src/myrmidon/process-orchestrator/config.ts
//
// myrmidon(1.6.6 PROCS-T1.5): the launch map of the multi-process board —
// N `api` processes and M `worker` processes with their ports and queue
// ownership written down in one place (design OPE-5394 §2 and §7, the roles
// gate of PROCS-1.1, the supervisor of PROCS-1.2). Pure functions and
// constants only — no DB, no timers, no `child_process` — so the dev-stack
// launcher (`scripts/dev-procs.ts`), the future supervisor and the tests all
// share one card of "what should be running where" and never re-parse the
// env with drifting rules.
//
// The map is the artifact the ticket asks for; the runtime switch itself
// stays off: nothing in `server/src/index.ts` consumes this module yet, so a
// single-process board behaves byte-for-byte as before.
//
// Env contract (SETTINGS.md section "1.6.6 — PROCS-T1.5"):
// - `PAPERCLIP_PROCESS_MODE`      — `single` (default) | `split`. The
//   emergency escape of design §7.2; the name is reserved by PROCS-1.1
//   (packages/shared `myrmidon-processes.ts`), this module is its pure
//   reader for the launcher.
// - `MYRMIDON_API_PROCESSES`      — N: number of api processes (default 2 —
//   the design §7.3 recommendation for the 4-core container — range 1..4,
//   the `apiCount` bound of PROCS-1.1).
// - `MYRMIDON_WORKER_PROCESSES`   — M: number of worker processes (default
//   1, range 1..2). Design rule: stage 1 keeps ONE executor of runs, so the
//   production split is `M=1`; `M=2` exists for the dev stand of this ticket
//   (the sweep queues split over the two workers) and is logged as
//   off-recommendation by the launcher.
// - `PORT`                        — the base api port (the board's own
//   config rule: `Number(PORT) || config file || 3100`).
// - `MYRMIDON_API_PORT_STRIDE`    — per-process port step of the api block:
//   api-i binds `PORT + i*stride`. Default `1` — every dev-stack process
//   gets its own port and is individually probeable. `0` is the production
//   shape of design §7.1 (all api bind the SAME `PORT` via `reusePort`),
//   which only works once the PROCS-1.2 supervisor lands; with `1` api
//   process the two shapes coincide.
// - `MYRMIDON_WORKER_PORT`        — base of the worker block (default
//   `PORT + 4`, i.e. 3104 with the stock api port): worker-i binds
//   `MYRMIDON_WORKER_PORT + i` on the loopback interface for the
//   single-route proxy and its own metrics. The design's production value
//   for the single worker is 3101 (PROCS-1.1 `PROCESS_ROLE_WORKER_PORT`);
//   the dev default avoids it because the api block occupies 3100..3103 as
//   long as stride > 0, and a launch map whose ports collide is a config
//   error, not a deployment.
// - `MYRMIDON_WORKER_HOST`        — bind of the worker listeners (default
//   `127.0.0.1`; api processes keep the ambient `HOST`).
// - `PAPERCLIP_PROCESS_ROLE`      — this process's role (`all` | `worker` |
//   `api`); the launcher WRITES it into every child, the child's startup
//   gates read it (PROCS-1.1).
// - `MYRMIDON_WORKER_QUEUES`      — the execution-control queues THIS
//   worker sweeps, comma-separated. The launcher WRITES the per-worker
//   slice (round-robin over the seven-queue list below) into each worker
//   child so the split is a property of the launch map, not of code; a
//   standalone `PAPERCLIP_PROCESS_ROLE=worker` process may set it by hand.
//   Unset on a worker means "all queues" — the single-worker shape.
// - `PAPERCLIP_PARENT_BOOT_ID`    — bootId of the launching parent, carried
//   into every child so its registry row can name its supervisor
//   (PROCS-1.2 `PARENT_BOOT_ID_ENV`).
// - `DATABASE_URL`                — inherited unchanged. Without it every
//   child falls back to the board's embedded Postgres: the first process to
//   start owns the cluster, the later ones reuse the running postmaster
//   (`server/src/index.ts` pid-file path). The launcher therefore brings
//   children up sequentially behind a health gate — two children
//   initialising the same data directory in parallel is the corruption this
//   ticket must not ship.

/** Env var naming the launch mode (vendor name, reserved by PROCS-1.1). */
export const PROCESSES_MODE_ENV = "PAPERCLIP_PROCESS_MODE";

/** Env var naming the role of THIS process; the launcher writes it into
 * every child env. */
export const PROCESS_ROLE_ENV = "PAPERCLIP_PROCESS_ROLE";

/** Env var carrying the bootId of the launching parent into a forked child,
 * so the child's registry row can name its parent (PROCS-1.2). */
export const PARENT_BOOT_ID_ENV = "PAPERCLIP_PARENT_BOOT_ID";

/** Env var: number of api processes (N). */
export const API_COUNT_ENV = "MYRMIDON_API_PROCESSES";

/** Env var: number of worker processes (M). */
export const WORKER_COUNT_ENV = "MYRMIDON_WORKER_PROCESSES";

/** Env var: per-process port step of the api block (`0` = shared port). */
export const API_PORT_STRIDE_ENV = "MYRMIDON_API_PORT_STRIDE";

/** Env var: base of the worker loopback port block. */
export const WORKER_PORT_ENV = "MYRMIDON_WORKER_PORT";

/** Env var: the bind of the worker listeners. */
export const WORKER_HOST_ENV = "MYRMIDON_WORKER_HOST";

/** Env var: comma-separated execution-control queues this worker sweeps;
 * written per worker child by the launcher. */
export const WORKER_QUEUES_ENV = "MYRMIDON_WORKER_QUEUES";

/** Env var: this process's index inside its role block (`worker-1` → `1`);
 * written by the launcher, read by the queue/gate code of PROCS-1.2. */
export const PROCESS_INDEX_ENV = "MYRMIDON_PROCESS_INDEX";

/** The board's own port env (vendor `config.ts`), the base of the api block. */
export const BOARD_PORT_ENV = "PORT";

/** Accepted values of {@link PROCESSES_MODE_ENV}. */
export const BOARD_PROCESS_MODES = ["single", "split"] as const;
export type BoardProcessMode = (typeof BOARD_PROCESS_MODES)[number];

export type BoardProcessRole = "all" | "api" | "worker";

/** The board's well-known port: `server/src/config.ts` resolves
 * `Number(PORT) || fileConfig.server.port || 3100`. */
export const DEFAULT_API_PORT = 3100;

/** The loopback bind of the worker listeners (PROCS-1.1
 * `PROCESS_ROLE_WORKER_HOST`). */
export const DEFAULT_WORKER_HOST = "127.0.0.1";

/** Default number of api processes — the design §7.3 recommendation for
 * the 4-core container. */
export const RECOMMENDED_API_COUNT = 2;

/** Default number of worker processes — design rule: one executor in
 * stage 1; `M=2` is the dev-stand shape. */
export const RECOMMENDED_WORKER_COUNT = 1;

/** N bound, same as the `apiCount` range of PROCS-1.1
 * (`PROCESSES_API_COUNT_MIN`/`MAX`). */
export const API_COUNT_MIN = 1;
export const API_COUNT_MAX = 4;

/** M bound: the ticket's dev stand asks for `M=2`; a third worker would
 * only shard the sweeps further than the board has sweep lanes worth of. */
export const WORKER_COUNT_MIN = 1;
export const WORKER_COUNT_MAX = 2;

/** Port-step bound: the api block may span at most this many ports above
 * the base before the map is considered misconfigured. */
export const API_PORT_STRIDE_MAX = 8;

/** The worker block starts, by default, `PORT + WORKER_PORT_BASE_OFFSET`
 * above the api base so the two blocks cannot collide for any in-range
 * (N, M, stride). */
export const WORKER_PORT_BASE_OFFSET = 4;

/** The seven execution-control sweep queues of the board — the list in
 * `server/src/index.ts` (`executionControlSweeps`: finalization,
 * replacement, reconciliation_delivery, status_delivery,
 * automatic_disposition, local_ai_login_cleanup, run_stall). The card of
 * "which queue runs in which role": in `split` the whole list belongs to
 * the workers — an api process owns none of it, and the per-lane metrics
 * of PROCS-0.3A report the same split (`execution_control` lane). */
export const EXECUTION_CONTROL_QUEUES = [
  "finalization",
  "replacement",
  "reconciliation_delivery",
  "status_delivery",
  "automatic_disposition",
  "local_ai_login_cleanup",
  "run_stall",
] as const;
export type ExecutionControlQueue = (typeof EXECUTION_CONTROL_QUEUES)[number];

/** True for the roles that run background work. Mirrors PROCS-1.1
 * `roleOwnsBackgroundWork`: an api process serves HTTP/WS and owns none of
 * the timers. */
export function roleOwnsBackgroundWork(role: BoardProcessRole): boolean {
  return role !== "api";
}

/**
 * Split the seven execution-control queues over M workers, round-robin by
 * the canonical order of {@link EXECUTION_CONTROL_QUEUES}: deterministic
 * (the same map always yields the same slice) and balanced (with M=2 the
 * first worker sweeps 4 queues, the second 3). `M=1` returns the whole
 * list on worker-0 — the production shape of design rule 3 (one executor).
 */
export function assignExecutionControlQueues(
  workerCount: number = WORKER_COUNT_MIN,
): string[][] {
  if (!Number.isInteger(workerCount) || workerCount < WORKER_COUNT_MIN || workerCount > WORKER_COUNT_MAX) {
    throw new ProcessConfigError(
      `worker count must be between ${WORKER_COUNT_MIN} and ${WORKER_COUNT_MAX}, got ${workerCount}`,
    );
  }
  const buckets: string[][] = Array.from({ length: workerCount }, () => []);
  EXECUTION_CONTROL_QUEUES.forEach((queue, index) => {
    buckets[index % workerCount]!.push(queue);
  });
  return buckets;
}

/** Parse a `MYRMIDON_WORKER_QUEUES` value into the ordered list of queue
 * names it names. Empty/unset → the whole {@link EXECUTION_CONTROL_QUEUES}
 * list (the single-worker shape). Unknown name → error: a typo would
 * silently leave a sweep queue unswept. */
export function parseWorkerQueues(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (value === "") return [...EXECUTION_CONTROL_QUEUES];
  const names = value.split(",").map((part) => part.trim()).filter(Boolean);
  const known = new Set<string>(EXECUTION_CONTROL_QUEUES);
  for (const name of names) {
    if (!known.has(name)) {
      throw new ProcessConfigError(
        `unknown execution-control queue "${name}" in ${WORKER_QUEUES_ENV} (known: ${EXECUTION_CONTROL_QUEUES.join(", ")})`,
      );
    }
  }
  return [...new Set(names)];
}

/** One entry of the launch map: what to spawn and with which env overlay. */
export type ProcessPlanEntry = {
  /** Stable, human-readable id, used as the log prefix: `worker-0`, `api-1`. */
  name: string;
  role: BoardProcessRole;
  /** Index inside the role block. */
  index: number;
  /** The port this process binds as its main listener (api: `PORT +
   * index*stride`; worker: loopback block; all: `PORT`). */
  listenPort: number;
  /** The shared api port the board's clients use (both modes; `PORT`). */
  apiPort: number;
  /** The bind host for this entry's listener (workers: loopback; api/all:
   * inherited ambient `HOST`, mirrored here as `null` when the launcher
   * should not override it). */
  host: string | null;
  /** Execution-control queues this entry sweeps (`[]` for api). */
  queues: string[];
  /** Env overlay for the child process (stringified values only). */
  env: Record<string, string>;
};

export type ProcessMap = {
  mode: BoardProcessMode;
  apiCount: number;
  workerCount: number;
  /** The shared api port (both modes). */
  apiPort: number;
  /** The worker loopback block base. */
  workerBasePort: number;
  workerHost: string;
  apiPortStride: number;
  entries: ProcessPlanEntry[];
};

export class ProcessConfigError extends Error {}

function trimmedOrEmpty(raw: string | undefined): string {
  return (raw ?? "").trim();
}

/**
 * `PAPERCLIP_PROCESS_MODE`: `split` only on the exact value (case- and
 * space-tolerant); everything else — unset, junk, `triple` — resolves to
 * `single`, the byte-for-byte vendor behaviour. A typo must not half-split
 * a dev stack.
 */
export function resolveProcessMode(
  raw: string | undefined = process.env[PROCESSES_MODE_ENV],
): BoardProcessMode {
  const value = trimmedOrEmpty(raw).toLowerCase();
  return value === "split" ? "split" : "single";
}

/** Integer setting with an explicit range. Empty → default; junk, zero,
 * negative, fractional or out-of-range → hard error: in `split` a
 * silently-wrong count is a half-launched board, the same rule PROCS-1.1's
 * zod schema applies to the stored `apiCount`. */
export function resolveBoundedCount(
  envName: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = trimmedOrEmpty(raw);
  if (value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ProcessConfigError(
      `${envName} must be a whole number between ${min} and ${max}, got "${raw}"`,
    );
  }
  return parsed;
}

/** Port: 1024..65535 (the board runs unprivileged; below 1024 needs root). */
export function resolvePort(envName: string, raw: string | undefined, fallback: number): number {
  const value = trimmedOrEmpty(raw);
  if (value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new ProcessConfigError(
      `${envName} must be a whole port between 1024 and 65535, got "${raw}"`,
    );
  }
  return parsed;
}

/** The ports the api block occupies: `PORT + i*stride` for i in 0..N-1.
 * Exported for the launcher's readiness probes and for tests. */
export function apiBlockPorts(apiPort: number, apiCount: number, stride: number): number[] {
  return Array.from({ length: apiCount }, (_, i) => apiPort + i * stride);
}

/** The ports the worker block occupies: base..base+M-1. */
export function workerBlockPorts(workerBasePort: number, workerCount: number): number[] {
  return Array.from({ length: workerCount }, (_, i) => workerBasePort + i);
}

/**
 * Build the launch map from an env bag (defaults to `process.env`). The
 * one-command dev stack (`pnpm dev:procs`) and — once PROCS-1.2's
 * supervisor lands on main — the runtime itself consume exactly this map,
 * which is the point of T1.5: the map lives once.
 *
 * - `single` → one entry, role `all`, the external port, no overlays —
 *   today's board, byte for byte.
 * - `split`  → M workers + N api. Worker-i binds the loopback
 *   `MYRMIDON_WORKER_PORT + i` and sweeps its round-robin slice of the
 *   execution-control queues (`MYRMIDON_WORKER_QUEUES`, written into its
 *   env). Api-i binds `PORT + i*MYRMIDON_API_PORT_STRIDE`, owns no queue,
 *   and dials the worker block's base (`MYRMIDON_WORKER_HOST:base`) for
 *   the single-route proxy of design §7.1. Every child carries
 *   `PAPERCLIP_PROCESS_ROLE` so its startup gates behave exactly like
 *   PROCS-1.1 specifies. A port collision between the two blocks — or two
 *   api children on one port while stride is not the shared `0` handled by
 *   the future supervisor — is a hard config error before anything spawns.
 */
export function buildProcessMap(env: NodeJS.ProcessEnv = process.env): ProcessMap {
  const mode = resolveProcessMode(env[PROCESSES_MODE_ENV]);
  const apiPort = resolvePort(BOARD_PORT_ENV, env[BOARD_PORT_ENV], DEFAULT_API_PORT);
  const workerHost = trimmedOrEmpty(env[WORKER_HOST_ENV]) || DEFAULT_WORKER_HOST;
  const workerBasePort = resolvePort(
    WORKER_PORT_ENV,
    env[WORKER_PORT_ENV],
    apiPort + WORKER_PORT_BASE_OFFSET,
  );

  if (mode === "single") {
    return {
      mode,
      apiCount: 1,
      workerCount: 0,
      apiPort,
      workerBasePort,
      workerHost,
      apiPortStride: 0,
      entries: [
        {
          name: "board",
          role: "all",
          index: 0,
          listenPort: apiPort,
          apiPort,
          host: null,
          queues: [...EXECUTION_CONTROL_QUEUES],
          env: {},
        },
      ],
    };
  }

  const apiCount = resolveBoundedCount(API_COUNT_ENV, env[API_COUNT_ENV], RECOMMENDED_API_COUNT, API_COUNT_MIN, API_COUNT_MAX);
  const workerCount = resolveBoundedCount(WORKER_COUNT_ENV, env[WORKER_COUNT_ENV], RECOMMENDED_WORKER_COUNT, WORKER_COUNT_MIN, WORKER_COUNT_MAX);
  const apiPortStride = resolveBoundedCount(API_PORT_STRIDE_ENV, env[API_PORT_STRIDE_ENV], 1, 0, API_PORT_STRIDE_MAX);
  if (apiPortStride === 0 && apiCount > 1) {
    // The shared-port shape of design §7.1 needs `reusePort` in the child's
    // `listen` — that is PROCS-1.2's job. Until it exists, N>1 api
    // children on one port are a boot race, not a split.
    throw new ProcessConfigError(
      `${API_PORT_STRIDE_ENV}=0 with ${apiCount} api processes requires the PROCS-1.2 supervisor (reusePort); use a stride of 1 or more`,
    );
  }

  const apiPorts = apiBlockPorts(apiPort, apiCount, apiPortStride);
  const workerPorts = workerBlockPorts(workerBasePort, workerCount);
  const collision = workerPorts.find((port) => apiPorts.includes(port));
  if (collision !== undefined) {
    throw new ProcessConfigError(
      `worker block (${workerPorts.join(", ")}) collides with the api block (${apiPorts.join(", ")}); raise ${WORKER_PORT_ENV} or move ${BOARD_PORT_ENV}`,
    );
  }

  const queueSlices = assignExecutionControlQueues(workerCount);
  const entries: ProcessPlanEntry[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    const queues = queueSlices[i]!;
    entries.push({
      name: `worker-${i}`,
      role: "worker",
      index: i,
      listenPort: workerPorts[i]!,
      apiPort,
      host: workerHost,
      queues,
      env: {
        [PROCESS_ROLE_ENV]: "worker",
        [PROCESSES_MODE_ENV]: "split",
        [PROCESS_INDEX_ENV]: String(i),
        // The worker's own listener is the loopback block port; it must
        // not bind the shared api port in `split` (design §2.1).
        [BOARD_PORT_ENV]: String(workerPorts[i]),
        // The worker binds its loopback block port (design §2.1: full app
        // on loopback for the proxy + metrics), never the api interface.
        HOST: workerHost,
        [WORKER_PORT_ENV]: String(workerBasePort),
        [WORKER_HOST_ENV]: workerHost,
        [WORKER_QUEUES_ENV]: queues.join(","),
      },
    });
  }
  for (let i = 0; i < apiCount; i += 1) {
    entries.push({
      name: `api-${i}`,
      role: "api",
      index: i,
      listenPort: apiPorts[i]!,
      apiPort,
      host: null,
      queues: [],
      env: {
        [PROCESS_ROLE_ENV]: "api",
        [PROCESSES_MODE_ENV]: "split",
        [PROCESS_INDEX_ENV]: String(i),
        [BOARD_PORT_ENV]: String(apiPorts[i]!),
        // Where this api process dials the workers (single-route proxy):
        // the block base — worker-0 owns the proxy routes of design §7.1.
        [WORKER_PORT_ENV]: String(workerBasePort),
        [WORKER_HOST_ENV]: workerHost,
      },
    });
  }

  return { mode, apiCount, workerCount, apiPort, workerBasePort, workerHost, apiPortStride, entries };
}

/** True when the map asks for more workers than design rule 3 keeps in
 * stage 1 — the launcher logs this as a warning, not an error. */
export function exceedsRecommendedWorkerCount(map: ProcessMap): boolean {
  return map.mode === "split" && map.workerCount > RECOMMENDED_WORKER_COUNT;
}

/** One line of the launch card, for logs and `--dry-run`: name, role,
 * bound port, and the queues the entry owns. */
export function describeProcessMap(map: ProcessMap): string[] {
  return map.entries.map((entry) => {
    const bind =
      entry.role === "worker"
        ? `bind ${entry.host}:${entry.listenPort} (loopback)`
        : entry.role === "api"
          ? `bind ${entry.listenPort === entry.apiPort ? `${entry.apiPort} (api)` : `${entry.listenPort} (api slot, clients use ${entry.apiPort})`}`
          : `bind ${entry.listenPort} (api)`;
    const queues = entry.role === "worker"
      ? `sweeps ${entry.queues.length === EXECUTION_CONTROL_QUEUES.length ? "all" : entry.queues.length} execution-control queue(s)`
      : entry.role === "api"
        ? `dials ${map.workerHost}:${map.workerBasePort}; owns no queue`
        : "owns all background work";
    return `${entry.name.padEnd(9)} ${entry.role.padEnd(6)} ${bind}; ${queues}`;
  });
}
