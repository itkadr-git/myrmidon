## summary

Trace performed against the product repository at `origin/main` (2026-10-15). The literal `chr-p*` prefix and Chromium config names supplied in the task do not occur in tracked product files or reachable git history. The deployment repository/configuration that creates those paths was not available in this checkout, so ownership, root, TTL, and trap cleanup for `chr-p*` remain unverified. Do not remove matching host paths based on name alone.

### Confirmed product-owned writers

| Writer | Root / name | Cleanup and lifecycle |
| --- | --- | --- |
| `server/src/services/run-scratch.ts:90` | `os.tmpdir()/paperclip-run-<issue>-<run>-XXXXXX`; installs this path as run scratch and (unless explicitly set already) `TMPDIR`, `TEMP`, and `TMP` for local heartbeat execution | `heartbeat.ts` prepares it before adapter dispatch and calls `cleanupHeartbeatRunScratch` after a terminal run. Cleanup requires the path to remain under `os.tmpdir()`, a `paperclip-run-` basename, a valid ownership marker matching company/agent/run, and no live process group; then recursively removes it. There is no age TTL or independent stale-directory sweeper. Nonterminal runs and crashes before terminal cleanup can leave owned scratch behind. |
| `server/src/services/ai-connection-runtime.ts:232` | `os.tmpdir()/paperclip-ai-<company>-<grant>-XXXXXX`, used for an isolated temporary HOME/config for AI auth | Removed in `finally` and again on outer error. No TTL; abnormal process termination can strand it. |
| `packages/adapter-utils/src/execution-target.ts:2147` | `os.tmpdir()/paperclip-process-session-proxy-XXXXXX`, containing the local ACP process-session proxy script | Removed in process-session `stop()` during execution teardown, best effort. No TTL; abrupt process death may strand it. |

These roots inherit `os.tmpdir()` and thus do not guarantee non-tmpfs storage. The deployment-specific `chr-p*`, Chromium cache/config, and `native-*` roots cannot be attributed from this repository search; no cleanup policy or TTL for them is established here.

## Scope and conclusion

No product-owned writer for the task's exact Chromium/`chr-p*` names was confirmed, so no speculative product fix was made. Product-owned writers above already have normal-path teardown; all have crash/abnormal-exit residual risk and no TTL scavenger. A follow-up deployment trace needs the repository/host configuration that creates `chr-p*` and `native-*`, including service unit/container mounts and cleanup scripts. This report does not authorize deleting unowned host paths.
