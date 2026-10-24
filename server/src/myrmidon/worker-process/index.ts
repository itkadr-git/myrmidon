// server/src/myrmidon/worker-process/index.ts
//
// myrmidon(1.6.6 PROCS-1.5 ч.H, design BOARD-PROCESSES §2.1): the standalone
// worker entry — a dedicated launch point for the `worker` role of the process
// contract that already lives on main: the role profile (`services/process-role`,
// PROCS-1.1: heartbeat executor, sweeps, backups, loopback listener), the
// supervisor (PROCS-1.2), the registry pulse with the process role
// (`process-registry`, PROCS-0.1) and the readiness routes mounted by the board
// app itself (`process-readiness`, ч.F: `/internal/ready` and `/healthz`).
//
// This module adds none of that a second time. All it owns is the launch gate:
// `node dist/worker.js` / `pnpm --filter @myrmidon/server worker` boot the SAME
// `startServer()` as `index.ts`, with the role forced to `worker`:
//   - role env unset  → the entry sets it to `worker` (the dedicated entry IS
//     the role statement);
//   - role env `worker` → as is (the orchestrator launcher writes it);
//   - any other role (`api`, `all`, junk) → refuse to start: a worker entry
//     that came up as `all` would run the whole background workload twice
//     against the api processes, and a loud refusal beats a quiet duplicate.
// The default single-process launch (`index.ts`, no role) is untouched.

import { readProductEnvFrom } from "@myrmidon/shared/env-alias";
import { PROCESS_ROLE_ENV, resolveProcessRole } from "../../services/process-role.js";
import { logger } from "../../middleware/logger.js";

export type WorkerLaunchEnv = NodeJS.ProcessEnv;

/** Applies the worker role to `env` when none is set, and refuses any other
 * explicit role. Returns the env that `startServer()` will read. */
export function applyWorkerRole(env: WorkerLaunchEnv = process.env): WorkerLaunchEnv {
  const raw = readProductEnvFrom(env, "PROCESS_ROLE");
  if (raw === undefined || raw.trim() === "") {
    env[PROCESS_ROLE_ENV] = "worker";
    return env;
  }
  const resolved = resolveProcessRole(raw);
  if (resolved.invalidValue || resolved.role !== "worker") {
    throw new Error(
      `worker-process: refusing to start — the worker entry needs the process role "worker" ` +
        `(got ${JSON.stringify(raw)}). Launch the board through index.ts for other roles; ` +
        `a worker entry running as another role would double the background workload.`,
    );
  }
  return env;
}

/** Standalone entry: forces the role gate, boots the board runtime, returns
 * the shutdown handle. */
export async function startWorkerProcess(options: {
  env?: WorkerLaunchEnv;
} = {}): Promise<{ close: () => Promise<void> }> {
  applyWorkerRole(options.env ?? process.env);
  const { startServer } = await import("../../index.js");
  const started = await startServer();
  if (started.processRole !== "worker" || !started.ownsBackgroundWork) {
    await started.shutdown("SIGTERM").catch((err) =>
      logger.warn({ err }, "worker-process: shutdown after a broken role gate failed"),
    );
    throw new Error(
      `worker-process: startServer came up with role ${started.processRole} ` +
        `(ownsBackgroundWork=${started.ownsBackgroundWork}); the role gate is broken`,
    );
  }
  return { close: () => started.shutdown("SIGTERM") };
}
