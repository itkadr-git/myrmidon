// server/src/myrmidon/process-orchestrator/launcher.ts
//
// myrmidon(1.6.6 PROCS-T1.5): the spawn card of the split board — the pure
// half of the launcher. `config.ts` answers "WHAT should be running where";
// this module answers "HOW each entry is started": command, args, cwd, env
// overlay and the readiness URL a supervisor must see green before the next
// entry goes up. Still no `child_process` here: the dev-stack runner
// (`scripts/dev-procs.ts`) and — once PROCS-1.2's supervisor lands on main —
// the runtime supervisor both consume exactly this card, so the spawn
// mechanics live once, and the tests run it inside the server vitest project
// without ever forking a process.
//
// Readiness ordering is load-bearing for the embedded-Postgres dev stand:
// `server/src/embedded-postgres-owner.ts` reuses a RUNNING postmaster by its
// pid file, but two children initialising the same data directory in
// parallel corrupt it. So the plan is started sequentially behind the health
// gate: worker-0 (the first child owns the DB bootstrap), then the rest in
// card order.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProcessMap, ProcessPlanEntry } from "./config.js";
import { PARENT_BOOT_ID_ENV, PROCESS_ROLE_ENV } from "./config.js";

const require = createRequire(import.meta.url);

/** Milliseconds a `waitForHealth` gate waits for one child before the
 * launcher calls it a failed boot. The first child pays embedded-Postgres
 * bootstrap plus migrations; the stock dev-runner waits on the same order
 * (`serverPort` health loop). */
// A cold dev stand can spend ~2 min just booting embedded PostgreSQL + the
// first-run migration sweep (measured on OPE-6875: healthy at ~130 s), so the
// readiness deadline is generous; a hung child still trips via its exit hook.
export const DEFAULT_CHILD_READY_TIMEOUT_MS = 300_000;

/** One line of the spawn card: everything `scripts/dev-procs.ts` (and the
 * future supervisor) needs to bring this entry up and probe it. */
export type LaunchSpec = {
  /** Card id (`worker-0`, `api-1`) — the log prefix. */
  name: string;
  role: ProcessPlanEntry["role"];
  /** Absolute path of the executable (this node binary). */
  command: string;
  /** tsx CLI + server entrypoint (+ `watch` when asked for). */
  args: string[];
  /** Working directory of the child — the `server` package root. */
  cwd: string;
  /** Env overlay for the child; the runner merges it over `process.env`. */
  env: Record<string, string>;
  /** Readiness probe the runner polls before starting the next entry. */
  healthUrl: string;
  /** The bound port of this entry (card copy of `entry.listenPort`). */
  port: number;
};

export type LaunchPlan = {
  /** Entries in spawn order: the card is workers-first (DB bootstrap and
   * queue ownership come up before the HTTP face). */
  specs: LaunchSpec[];
  /** Per-entry readiness timeout the runner should apply. */
  readyTimeoutMs: number;
};

/** Resolve the server package root from this file
 * (`src/myrmidon/process-orchestrator/launcher.ts` → `server/`). Identical
 * trick to `server/scripts/dev-watch.ts`. */
export function serverPackageRoot(fromModuleUrl: string = import.meta.url): string {
  const here = path.dirname(fileURLToPath(fromModuleUrl));
  return path.resolve(here, "..", "..", "..");
}

/** Resolve the tsx CLI path the way dev-watch does: from the server
 * package's own dependency tree, so the child runs the pinned tsx. */
export function resolveTsxCliPath(serverRoot: string): string {
  return require.resolve("tsx/cli", { paths: [serverRoot] });
}

/**
 * Build the spawn card for a launch map.
 *
 * - `watch: true` adds the tsx `watch` flag (the dev stand hot-reloads; the
 *   future production supervisor passes `false`).
 * - `bootId` is the launcher's own identity, written into every child as
 *   `PAPERCLIP_PARENT_BOOT_ID` (`PARENT_BOOT_ID_ENV`, the PROCS-1.2 name),
 *   so the children's registry rows can name their supervisor.
 * - The child env is the entry overlay from `config.ts` plus the parent
 *   bootId; nothing else is added — ambient `DATABASE_URL`, keys, and the
 *   board config file resolve in the child exactly as in single mode.
 */
export function buildLaunchPlan(
  map: ProcessMap,
  options: {
    watch?: boolean;
    bootId?: string;
    serverRoot?: string;
    tsxCliPath?: string;
    readyTimeoutMs?: number;
    /** Node executable for the children (defaults to the current one). */
    execPath?: string;
  } = {},
): LaunchPlan {
  const serverRoot = options.serverRoot ?? serverPackageRoot();
  const tsxCliPath = options.tsxCliPath ?? resolveTsxCliPath(serverRoot);
  // Watch mode runs `server/scripts/dev-watch.ts` — the same wrapper
  // `pnpm dev` uses, so the tsx-watch ignore set (dist, .paperclip, ...)
  // stays in one place. Non-watch runs `src/index.ts` directly, relative to
  // `cwd` (the server package root).
  const watch = options.watch ?? false;
  const serverEntry = watch ? "scripts/dev-watch.ts" : "src/index.ts";
  const args = [tsxCliPath, serverEntry];
  const bootId = options.bootId?.trim() || null;

  const specs: LaunchSpec[] = map.entries.map((planEntry) => {
    const env: Record<string, string> = { ...planEntry.env };
    if (bootId) env[PARENT_BOOT_ID_ENV] = bootId;
    // Belt and braces: config.ts already writes the role into every split
    // child; a single-mode card has no overlay and must still be labelled
    // for the PROCS-0.1 registry exactly as the ambient env would.
    if (!env[PROCESS_ROLE_ENV] && planEntry.role !== "all") {
      env[PROCESS_ROLE_ENV] = planEntry.role;
    }
    return {
      name: planEntry.name,
      role: planEntry.role,
      command: options.execPath ?? process.execPath,
      args: [...args],
      cwd: serverRoot,
      env,
      healthUrl: `http://127.0.0.1:${planEntry.listenPort}/api/health`,
      port: planEntry.listenPort,
    };
  });

  return {
    specs,
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_CHILD_READY_TIMEOUT_MS,
  };
}
