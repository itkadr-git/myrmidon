// server/src/services/process-role.ts
//
// myrmidon(PROCS-1.1): the one switch point for the *process role*. A board
// deployment may run one process that does everything (`all`, today's shape) or
// split the work between a scheduler process (`worker`) and HTTP-only processes
// (`api`). Every gate on background work in the server reads this module — the
// code must not grow a scattering of `if (someRoleFlag)` checks.
//
// The role is resolved from `PAPERCLIP_PROCESS_ROLE` (values `all|worker|api`,
// default `all`) once per process, so a running process never changes role.
//
// - `all`    — default, byte-for-byte today's behavior: HTTP on the configured
//              bind and every background timer/scheduler in this process.
// - `worker` — the scheduler process: every background timer/scheduler, run
//              execution, migrations, plus the internal loopback API on
//              `127.0.0.1:3101` that the api processes dial.
// - `api`    — HTTP only: no background timers, no run execution, no plugin
//              workers, no backups, and it *waits* for the worker's migrations
//              instead of applying them. The board surface is served on
//              `0.0.0.0:3100` with `reusePort`, so N api processes share the
//              listen port instead of fighting over it.
//
// An unknown value never silently invents a role: it falls back to `all` (the
// unchanged behavior) and reports itself as invalid, so the caller logs it
// loudly at startup.

/** Environment variable that overrides the process role. */
export const PROCESS_ROLE_ENV = "PAPERCLIP_PROCESS_ROLE";

/** The accepted values of {@link PROCESS_ROLE_ENV}. */
export const PROCESS_ROLE_VALUES = ["all", "worker", "api"] as const;

export type ProcessRole = (typeof PROCESS_ROLE_VALUES)[number];

/** Where the resolved role came from. */
export type ProcessRoleSource = "default" | "env";

/** The public bind the api processes share. */
export const PROCESS_ROLE_API_HOST = "0.0.0.0";
/** The port the api processes share (`reusePort`), matching the board's port. */
export const PROCESS_ROLE_API_PORT = 3100;
/** The internal loopback host the worker serves the board app on. */
export const PROCESS_ROLE_WORKER_HOST = "127.0.0.1";
/** The internal loopback port the worker serves the board app on. */
export const PROCESS_ROLE_WORKER_PORT = 3101;

/**
 * The listener the role binds for the primary HTTP/WS server.
 *
 * `host: null` / `port: null` mean "whatever the process was configured with"
 * (today's `config.host` / detected port), which is what `all` and `worker`
 * keep doing in a single-process deployment.
 */
export interface ProcessRoleListenSpec {
  host: string | null;
  port: number | null;
  reusePort: boolean;
}

/** The internal loopback listener a split deployment gives the worker. */
export interface ProcessRoleLoopbackListenSpec {
  host: string;
  port: number;
}

export interface ProcessRoleProfile {
  role: ProcessRole;
  source: ProcessRoleSource;
  /** The raw env value when one was present (`null` otherwise). */
  rawValue: string | null;
  /** The env value was present but not one of {@link PROCESS_ROLE_VALUES}. */
  invalidValue: boolean;
  /** Schedules timers, sweeps, plugin workers, backups — everything periodic. */
  runsBackground: boolean;
  /** May claim and execute runs (`startNextQueuedRunForAgent` and neighbours). */
  executesRuns: boolean;
  /** The role that owns the database migrations; the others wait for them. */
  migrations: "apply" | "await";
  /** Runs the periodic database backups. */
  runsBackups: boolean;
  /** The primary listener spec for this role. */
  listen: ProcessRoleListenSpec;
  /** The extra loopback listener, or `null` when the role does not open one. */
  loopbackListen: ProcessRoleLoopbackListenSpec | null;
}

export interface ResolvedProcessRole {
  role: ProcessRole;
  source: ProcessRoleSource;
  rawValue: string | null;
  invalidValue: boolean;
}

/**
 * Resolves the configured role without falling over: an unset value is the
 * default `all`, and an unrecognized value is `all` marked `invalidValue` so the
 * caller can warn instead of starting a process with an undefined role.
 */
export function resolveProcessRole(
  raw: string | null | undefined = process.env[PROCESS_ROLE_ENV],
): ResolvedProcessRole {
  const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (trimmed.length === 0) {
    return { role: "all", source: "default", rawValue: null, invalidValue: false };
  }
  const match = (PROCESS_ROLE_VALUES as readonly string[]).includes(trimmed)
    ? (trimmed as ProcessRole)
    : null;
  if (!match) {
    return { role: "all", source: "default", rawValue: trimmed, invalidValue: true };
  }
  return { role: match, source: "env", rawValue: trimmed, invalidValue: false };
}

/**
 * The complete profile of an explicit role. Kept separate from the env lookup so
 * tests, the startup banner and (in a later part) the supervisor all describe a
 * role the same way.
 */
export function processRoleProfileFor(role: ProcessRole): Omit<ProcessRoleProfile, "source" | "rawValue" | "invalidValue"> {
  switch (role) {
    case "api":
      return {
        role,
        runsBackground: false,
        executesRuns: false,
        migrations: "await",
        runsBackups: false,
        listen: { host: PROCESS_ROLE_API_HOST, port: PROCESS_ROLE_API_PORT, reusePort: true },
        loopbackListen: null,
      };
    case "worker":
      return {
        role,
        runsBackground: true,
        executesRuns: true,
        migrations: "apply",
        runsBackups: true,
        // myrmidon(PROCS-1.1/1.2): the worker keeps the board's default public
        // bind. The supervisor (PROCS-1.2) decides whether the worker actually
        // serves :3100 (single, emergency) or leaves it to the api children —
        // through the mode it reads from the settings, not through the profile.
        listen: { host: null, port: null, reusePort: false },
        loopbackListen: { host: PROCESS_ROLE_WORKER_HOST, port: PROCESS_ROLE_WORKER_PORT },
      };
    case "all":
    default:
      return {
        role: "all",
        runsBackground: true,
        executesRuns: true,
        migrations: "apply",
        runsBackups: true,
        listen: { host: null, port: null, reusePort: false },
        loopbackListen: null,
      };
  }
}

/**
 * The process role for this process. Resolved on every call from the current
 * environment — cheap, pure, and free of side effects, so a caller may read it
 * wherever it needs a gate.
 */
export function processRole(
  env: NodeJS.ProcessEnv = process.env,
): ProcessRoleProfile & { resolvedFrom: NodeJS.ProcessEnv } {
  const resolved = resolveProcessRole(env[PROCESS_ROLE_ENV]);
  return {
    ...processRoleProfileFor(resolved.role),
    source: resolved.source,
    rawValue: resolved.rawValue,
    invalidValue: resolved.invalidValue,
    resolvedFrom: env,
  };
}

/**
 * The background work this role is allowed to start, enumerated. `all` and
 * `worker` schedule everything; `api` schedules nothing — the acceptance test
 * for PROCS-1.1 asserts exactly that.
 */
export interface ProcessBackgroundWorkPlan {
  /** The heartbeat scheduler interval (claims and runs agents). */
  heartbeatScheduler: boolean;
  /** The execution-control reconciliation sweep interval. */
  executionControlSweeps: boolean;
  /** Startup recovery and the periodic recovery sweeps. */
  startupRecovery: boolean;
  /** The environment/sandbox sweeps that also run with heartbeat disabled. */
  environmentSweeps: boolean;
  /** The board's own periodic work scheduled inside the app (exports, spools). */
  appTimers: boolean;
  /** Plugin worker processes and the plugin job scheduler. */
  pluginWorkers: boolean;
  /** The periodic database backups. */
  backups: boolean;
  /** The worker's internal loopback listener on 127.0.0.1:3101. */
  loopbackApi: boolean;
}

export function processBackgroundWorkPlan(
  profile: Pick<ProcessRoleProfile, "role" | "runsBackground" | "runsBackups">,
): ProcessBackgroundWorkPlan {
  const background = profile.runsBackground;
  return {
    heartbeatScheduler: background,
    executionControlSweeps: background,
    startupRecovery: background,
    environmentSweeps: background,
    appTimers: background,
    pluginWorkers: background,
    backups: background && profile.runsBackups,
    loopbackApi: profile.role === "worker",
  };
}