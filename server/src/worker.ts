// server/src/worker.ts
//
// myrmidon(1.6.6 PROCS-1.5 ч.H, design BOARD-PROCESSES §2.1): the standalone
// worker entry — `node dist/worker.js` (dev: `pnpm --filter @myrmidon/server
// worker`). Boots the same board runtime as index.ts with the process role
// `worker`; the role profile, supervisor, registry and readiness routes are
// the ones already on main (see myrmidon/worker-process/index.ts). The default
// single-process launch (`node dist/index.js`) is untouched by this file.

import { logger } from "./middleware/logger.js";
import { startWorkerProcess } from "./myrmidon/worker-process/index.js";

// One SIGINT/SIGTERM handler per process (OPE-9107): `startServer` installs it
// and its shutdown is idempotent. This entry only covers the boot window: a
// signal during the (long) boot recovery is remembered and, once the runtime is
// up, handed to that same shutdown instead of killing the process mid-boot.
let pending: "SIGINT" | "SIGTERM" | null = null;
const early = (signal: "SIGINT" | "SIGTERM") => () => {
  pending ??= signal;
};
const onSigint = early("SIGINT");
const onSigterm = early("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

const worker = await startWorkerProcess();
process.off("SIGINT", onSigint);
process.off("SIGTERM", onSigterm);

if (pending) {
  const signal = pending;
  try {
    await worker.close();
    logger.info({ signal }, "worker-process: shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err, signal }, "worker-process: shutdown failed");
    process.exit(1);
  }
}
