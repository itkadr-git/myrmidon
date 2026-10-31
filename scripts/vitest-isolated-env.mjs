import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import path from "node:path";

// Private, throw-away environment for one Vitest process (or one forked test
// file): its own PAPERCLIP_HOME / PAPERCLIP_CONFIG / PAPERCLIP_INSTANCE_ID /
// TMPDIR under a fresh `pv-*` directory. Returns the directory and the
// variables to merge into the child environment.
//
// scripts/run-vitest-stable.mjs used to start one Vitest process per serialized
// route/authz suite and gave every process this environment; the serialized
// lane now runs a whole shard in one Vitest process (so modules are transformed
// once per shard, not once per file) and vitest-isolated-worker-env.mjs gives
// every forked test file the same private environment, so no file can see
// state left behind by another one.
export function createIsolatedTestEnv({ tempRootParent, instanceId }) {
  // Production workspace/security checks reject symlink aliases. In particular
  // /tmp is /private/tmp on macOS, so fixture roots must use the canonical path.
  const testRoot = realpathSync(mkdtempSync(path.join(tempRootParent, "pv-")));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = {
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    // Config discovery otherwise prefers the checkout's .paperclip/config.json
    // over PAPERCLIP_HOME, importing preview scheduling policy into unit tests.
    PAPERCLIP_CONFIG: path.join(testRoot, "h", "config.json"),
    PAPERCLIP_INSTANCE_ID: instanceId,
    TMPDIR: path.join(testRoot, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  return { testRoot, env };
}
