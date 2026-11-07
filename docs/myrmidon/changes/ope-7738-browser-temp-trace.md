## changelog-en

### Browser and runtime temp path trace (OPE-7738)

- Document confirmed product-owned run temp writers, Google AI and ChatGPT login-profile lifecycles, and completed vm-core runtime trace (OPE-7744/OPE-8747): no active production writers for `chr-p*` or `native-*` (historical residue on tmpfs); no product code changes required.

## changelog-ru

### Трассировка временных путей браузера и рантайма (OPE-7738)

- Задокументированы подтверждённые писатели временных каталогов запусков, жизненный цикл профилей Google AI и ChatGPT и результаты трассировки vm-core (OPE-7744/OPE-8747): активных писателей `chr-p*` и `native-*` в проде нет (исторический мусор на tmpfs); правок кода продукта не требуется.

The product repository was inspected at `origin/main` (2026-10-15). It contains none of the task's literal `chr-p*` or Chromium config writer names. The deployment paths below come from the separate `myrmidon-deploy` repository at branch `main`, commit `43a6169c2e6da642f4d14bd5b09c029cc75e691c`, combined with vm-core runtime audits (OPE-7742, OPE-7744, OPE-8747). Exact `chr-p*` and deployment `native-*` temporary writers were determined to have no active automated writers in production; unowned host paths must not be removed based on name alone.

### Runtime findings on vm-core (OPE-7742, OPE-7744, OPE-8747)

Systematic read-only observations and audits on vm-core established the following runtime facts:

- Host `/tmp` is `tmpfs` (`findmnt -T`, size about 34 GiB). It historically held 27 `/tmp/native-*` directories (dated 2026-10-11 to 2026-10-12, total ~263 MiB, owned by `openclaw-adm2`). Subsequent live audits (OPE-8747) observed 0 active `/tmp/native-*` and 0 `/tmp/chr-p*` directories.
- No automated production service or recurring job creates `chr-p*` or `native-*`. In production, the native runner is disabled (`enableNativeRunner=false`). The historical `native-*` directories were one-off residue from `openclaw-adm2` host activity rather than an automated product/service leak.
- Active Chromium writer identified: container `agy-login-3` running `/opt/rb.py` (originating from host `/srv/agy-pool-ctl/rb.py`) with `--user-data-dir=/profile --no-sandbox`. The script intercepts SIGINT/SIGTERM and terminates Chromium gracefully (up to 12s timeout). However, abnormal crashes or SIGKILL can leave residual files on tmpfs.
- Bot containers mount `/tmp` as tmpfs, `/dev/shm` as tmpfs (64 MiB), and `/bot` as an XFS bind from `/srv/myrmidon-bots/<id>`. No Chromium executable exists on standard bot PATHs.
- Exhaustive searches across `paperclip-server-1`, `myrmidon-dockergate`, `myrmidon-bot-*`, and host process trees confirmed no unaccounted background writers.
- Operational directive: unowned host paths must not be deleted on name alone.

### Confirmed product-owned writers

| Writer | Root / name | Cleanup and lifecycle |
| --- | --- | --- |
| `server/src/services/run-scratch.ts:90` | `os.tmpdir()/paperclip-run-<issue>-<run>-XXXXXX`; installs this path as run scratch and (unless explicitly set already) `TMPDIR`, `TEMP`, and `TMP` for local heartbeat execution | `heartbeat.ts` prepares it before adapter dispatch and calls `cleanupHeartbeatRunScratch` after a terminal run. Cleanup requires the path to remain under `os.tmpdir()`, a `paperclip-run-` basename, a valid ownership marker matching company/agent/run, and no live process group; then recursively removes it. There is no age TTL or independent stale-directory sweeper. Nonterminal runs and crashes before terminal cleanup can leave owned scratch behind. |
| `server/src/services/ai-connection-runtime.ts:232` | `os.tmpdir()/paperclip-ai-<company>-<grant>-XXXXXX`, used for an isolated temporary HOME/config for AI auth | Removed in `finally` and again on outer error. No TTL; abnormal process termination can strand it. |
| `packages/adapter-utils/src/execution-target.ts:2147` | `os.tmpdir()/paperclip-process-session-proxy-XXXXXX`, containing the local ACP process-session proxy script | Removed in process-session `stop()` during execution teardown, best effort. No TTL; abrupt process death may strand it. |

These roots inherit `os.tmpdir()` and thus do not guarantee non-tmpfs storage. The deployment trace in `myrmidon-deploy` (branch `main`, inspected commit `43a6169c2e6da642f4d14bd5b09c029cc75e691c`) found two actual persistent Chromium login-profile writers, but no `chr-p*` path and no matching `native-*` runtime writer:

- Google AI login: `connectors/google-ai/pool/gaipool.py:start_login()` creates `/srv/gai-connector/pool/acc/N/login/{out,profile}` and a timestamp marker; Docker bind-mounts these to `/out` and `/profile`. `LOGIN_TTL` is 20 minutes; the watcher (3-second interval) closes expired windows with `stop_login()`, which force-removes the container and recursively removes the login dir. Successful `complete_login()` calls `stop_login()` after persisting cookies. Expiry is watcher-driven, not finally/trap cleanup; process/container crashes can leave files until expiry is noticed or a later login removes the directory. `gai-login` Chromium uses `--user-data-dir=/profile`. Source references: `gaipool.py:35,44,177-205,298-312`; `login-browser/rb.py:49-60`; `pool/README.md:5-6,11`.
- ChatGPT login: `connectors/chatgpt-pool/autologin.py:start_browser()` creates `BASE/browser/accN/profile` (default base `/root/gateway/chatgpt-pool`; configured via `POOL_BASE`) and bind-mounts it to `/profile`. `worker()` always calls `stop_browser()` from `finally` (20-second graceful stop, then container removal), including the `Parked` path; this preserves the profile. Explicit `purge(n)` removes `bdir(n)`. However, at `origin/main` no per-account `chatgpt-pool-autologin@.service`, `ExecStartPre` purge, or `postinstall.md` exists; the API unit documents workers as transient `systemd-run` units. No stale-profile TTL is defined. Sources: `autologin.py:21,45-46,67-96,271-286,298-305,624-668`; `chatgpt-pool-api.service:7-10`; README:5,22,27-29; login-browser/rb.py:96.

### Conclusion and verification

1. Product code: All temporary paths created by product code are tracked, ownership-guarded, and deleted upon normal lifecycle completion. No code defect exists in the product repository, and no speculative product code changes are justified.
2. Deployment & runtime: Active Chromium logins use dedicated profile directories on persistent mounts (`/srv`, `/root`), with cleanup on login completion or watcher expiry. The historical `native-*` paths on host `/tmp` (tmpfs) were residual one-off artifacts from `openclaw-adm2`, with no active automated production writer.
3. Safety: Host paths must not be deleted without proven ownership. Audit complete.
