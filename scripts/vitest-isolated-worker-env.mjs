import os from "node:os";

import { createIsolatedTestEnv } from "./vitest-isolated-env.mjs";

// Preloaded (node --import, via Vitest's --execArgv) into every forked test
// file of the serialized lane. Vitest's forks pool with --isolate starts a
// fresh child process per test file; this gives that child its own
// PAPERCLIP_HOME / PAPERCLIP_CONFIG / PAPERCLIP_INSTANCE_ID / TMPDIR before any
// test code runs, which is what the former one-Vitest-process-per-file
// layout provided. See scripts/run-vitest-stable.mjs (runSerializedSuites).
//
// The fork inherits the runner's TMPDIR, so the per-file directories land
// under the shard's own `pv-*` root.
const { env } = createIsolatedTestEnv({
  tempRootParent: os.tmpdir(),
  instanceId: `vt-${process.ppid}-${process.pid}`,
});
Object.assign(process.env, env);
