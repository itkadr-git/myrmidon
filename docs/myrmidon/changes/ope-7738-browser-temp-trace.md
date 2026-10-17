## changelog-en

### Trace deployment Chromium login-profile lifecycles (OPE-7738)

- Document the Google AI and ChatGPT deployment browser-profile roots, TTLs, and cleanup paths; exact `chr-p*` and deployment `native-*` temp writers remain unidentified.

## changelog-ru

### Трассировка профилей Chromium в deployment (OPE-7738)

- Документированы корни, TTL и очистка профилей браузера Google AI и ChatGPT; точные deployment-писатели путей `chr-p*` и `native-*` пока не выявлены.


The product repository was inspected at `origin/main` (2026-10-15). It contains none of the task's literal `chr-p*` or Chromium config writer names. The deployment paths below come from the separate `myrmidon-deploy` repository at branch `main`, commit `43a6169c2e6da642f4d14bd5b09c029cc75e691c`. Exact `chr-p*` and deployment `native-*` temporary writers were not identified; do not remove matching host paths based on name alone.

### Confirmed product-owned writers

| Writer | Root / name | Cleanup and lifecycle |
| --- | --- | --- |
| `server/src/services/run-scratch.ts:90` | `os.tmpdir()/paperclip-run-<issue>-<run>-XXXXXX`; installs this path as run scratch and (unless explicitly set already) `TMPDIR`, `TEMP`, and `TMP` for local heartbeat execution | `heartbeat.ts` prepares it before adapter dispatch and calls `cleanupHeartbeatRunScratch` after a terminal run. Cleanup requires the path to remain under `os.tmpdir()`, a `paperclip-run-` basename, a valid ownership marker matching company/agent/run, and no live process group; then recursively removes it. There is no age TTL or independent stale-directory sweeper. Nonterminal runs and crashes before terminal cleanup can leave owned scratch behind. |
| `server/src/services/ai-connection-runtime.ts:232` | `os.tmpdir()/paperclip-ai-<company>-<grant>-XXXXXX`, used for an isolated temporary HOME/config for AI auth | Removed in `finally` and again on outer error. No TTL; abnormal process termination can strand it. |
| `packages/adapter-utils/src/execution-target.ts:2147` | `os.tmpdir()/paperclip-process-session-proxy-XXXXXX`, containing the local ACP process-session proxy script | Removed in process-session `stop()` during execution teardown, best effort. No TTL; abrupt process death may strand it. |

These roots inherit `os.tmpdir()` and thus do not guarantee non-tmpfs storage. The deployment trace in `myrmidon-deploy` (branch `main`, inspected commit `43a6169c2e6da642f4d14bd5b09c029cc75e691c`) found two actual persistent Chromium login-profile writers, but no `chr-p*` path and no matching `native-*` runtime writer:

- Google AI login: `connectors/google-ai/pool/gaipool.py:start_login()` creates `/srv/gai-connector/pool/acc/N/login/{out,profile}` and a timestamp marker; Docker bind-mounts these to `/out` and `/profile`. The root is configured under `/srv`, but that pathname alone does not prove non-tmpfs backing; deployment host `findmnt` evidence for this exact path is outstanding. `LOGIN_TTL` is 20 minutes; the watcher (3-second interval) closes expired windows with `stop_login()`, which force-removes the container and recursively removes the login dir. Successful `complete_login()` calls `stop_login()` after persisting cookies. Expiry is watcher-driven, not finally/trap cleanup; process/container crashes can leave files until expiry is noticed or a later login removes the directory. `gai-login` Chromium uses `--user-data-dir=/profile`. Source references: `gaipool.py:35,44,177-205,298-312`; `login-browser/rb.py:49-60`; `pool/README.md:5-6,11`.
- ChatGPT login: `connectors/chatgpt-pool/autologin.py:start_browser()` creates `BASE/browser/accN/profile` (default base `/root/gateway/chatgpt-pool`; configured via `POOL_BASE`) and bind-mounts it to `/profile`. `worker()` always calls `stop_browser()` from `finally` (20-second graceful stop, then container removal), including the `Parked` path; this preserves the profile. Explicit `purge(n)` removes `bdir(n)`. However, at `origin/main` no per-account `chatgpt-pool-autologin@.service`, `ExecStartPre` purge, or `postinstall.md` exists; the API unit documents workers as transient `systemd-run` units. No stale-profile TTL is defined. Host root is configured under `/root`, but actual backing filesystem is unverified. Sources: `autologin.py:21,45-46,67-96,271-286,298-305,624-668`; `chatgpt-pool-api.service:7-10`; README:5,22,27-29; login-browser/rb.py:96.

Searches in the deployment repository did not find the literal `chr-p*` prefix or any corresponding Chromium config writer. `native-*` matches refer to Chrome native messaging/signing-helper code, not temporary runtime directories; their lifecycle does not establish ownership of the paths in the task. No TTL, dedicated root, or cleanup policy can be asserted for the unidentified path patterns, and no host mount state was inspected. The earlier product-owned scratch-path observations remain as recorded above. No speculative fix was made.
