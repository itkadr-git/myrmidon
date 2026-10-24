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

const worker = await startWorkerProcess();

const shutdown = (signal: "SIGINT" | "SIGTERM") => {
  void worker
    .close()
    .then(() => {
      logger.info({ signal }, "worker-process: shutdown complete");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err, signal }, "worker-process: shutdown failed");
      process.exit(1);
    });
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
