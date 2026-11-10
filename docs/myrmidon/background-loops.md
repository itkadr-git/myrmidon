# Background loops registry (OPE-12618)

Source: epic OPE-12158 — «background loops by event instead of DB polling —
only chats do this today (D3)». This document is the input for slicing the
event-driven conversion of concrete cycles; no cycle is converted in this
task.

Ratchet: `server/src/myrmidon/monitoring/board-load/loops-ratchet.myrmidon.test.ts`
counts every `setInterval(` / `laneInterval(` / `backgroundInterval(` under
`server/src` (excluding `*.test.ts` and `__tests__`) and compares the counts
with the baseline map inside the test. A new timer without a baseline record
turns the test red with a hint pointing here.

## The eight `laneInterval` calls

| # | Cycle | Lane | Default period | What it reads from DB per tick | Event trigger today? | Suitable event (live event / process-bus channel) | Conversion risk |
|---|-------|------|----------------|--------------------------------|----------------------|-----------------------------------------------------|-----------------|
| 1 | `execution_control` | `execution_control` | 15 s (`EXECUTION_RECONCILIATION_INTERVAL_MS`) | `heartbeat_runs` (abandoned control rows), run-replacement candidates, status delivery queue, `local_ai_logins` expiry, stall settings, pause-guard rows | No | `heartbeat.run.status` live event; `run_control` process-bus channel; `run_queued` for finalization | Medium — leader-lease gate must stay; several sub-sweeps with different DB shapes |
| 2 | `heartbeat_tick` | `heartbeat_tick` | 30 s (`heartbeatSchedulerIntervalMs`, env `HEARTBEAT_SCHEDULER_INTERVAL_MS`, floor 10 s) | Decision expiry rows, retention queue, runtime-status table, timer rows due, provider-usage warnings, external objects, PR-merge confirmations, GitHub connection polls, workspace hygiene, alert recovery | No | `heartbeat.run.queued` live event for the timer tick; `run_queued` process-bus channel | High — the tick is a composite of ~15 sub-sweeps, each with its own DB read; converting piecemeal is safer than a single cutover |
| 3 | `bot_reconcile` | `bot_reconcile` | 60 s (`DEFAULT_RECONCILE_INTERVAL_MS`, env `MYRMIDON_BOT_RECONCILE_INTERVAL_SEC`) | `agents` table (bot cards), gateway leases, OOM events, media ACL registry, rollout watcher rows | No | `bot_apply_requested` process-bus channel (already exists for "Apply now"); `settings_changed` for config-driven recompile | Medium — sweep is idempotent and per-bot locking already exists; the event surface is small (card edits, apply-now, settings) |
| 4 | fleet memory sync | `bot_reconcile` | 15 min (`FLEET_MEMORY_SYNC_INTERVAL_MS`) | `myrmidon_fleet_sites`, `myrmidon_fleet_memory_syncs` journal, bot cards | No | None today — needs a new "site memory dirty" signal or a site-agent push webhook | High — pull-based by design (the board asks the site for export); converting to push requires a site-agent protocol change |
| 5 | fleet replica lane | `bot_reconcile` | 15 min (`FLEET_REPLICA_INTERVAL_MS`) | `myrmidon_fleet_sites`, replica store manifest, bot cards | No | None today — needs a "snapshot ready" event from the site-agent or a schedule annotation on the site | High — same pull-model constraint as memory sync; snapshots are large and paced one at a time |
| 6 | site health monitor | `bot_reconcile` | 30 s (`SITE_HEALTH_MONITOR_INTERVAL_MS` = `SITE_HEALTH_POLL_INTERVAL_MS`) | `myrmidon_fleet_sites`, heartbeat runs of bots on lost sites, failed-over / moving bot lists | No | `board.leader_changed` live event for failover decisions; a site-agent health webhook for probe results | Medium — probe is inherently periodic (health check); the DB-read part (failover decisions) could be event-driven, but the probe itself cannot |
| 7 | site scheduler lane | `bot_reconcile` | 30 s (`SITE_SCHEDULER_INTERVAL_MS`) | Bot cards (`agents`), company sites, affinity rules, open moves, pending-placement queue | No | `settings_changed` process-bus channel (affinity rules live in settings); `bot_apply_requested` for card edits | Medium — scheduler is a pure function over (bots, sites, rules); the read set is narrow and event sources are identifiable |
| 8 | chat reconcile fallback | `chat_reconcile` | 30 s (`MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS`) | `chat_publications`, `chat_actions`, `heartbeat_runs` (partial indexes from migration 0296) | Yes — `subscribeAllCompanyLiveEvents` → `notifyPublications` coalesced trigger (D3) | Already converted; the fallback timer is the safety net | Low — this is the reference pattern (D3) the other seven should follow |

## What each loop does (one-liner)

1. **execution_control** — reconciles abandoned execution-control rows, safe
   native replacements, status delivery, automatic disposition, local-AI
   login expiry, run-stall sweep, pause-guard sweep. Runs only on the
   leader-lease holder.
2. **heartbeat_tick** — the composite heartbeat scheduler tick: enqueues due
   timer runs, expires decisions, delivers provider-usage warnings, refreshes
   external objects, polls GitHub connections, sweeps workspaces and alerts.
   Also leader-gated.
3. **bot_reconcile** — reconciles the board's docker bot containers with the
   agent cards (image, env, mounts, gateway). One pass over all bots; a
   per-bot lock prevents double reconcile.
4. **fleet memory sync** — pulls the work-memory export of each reachable
   remote site into the board's replica bank (`fleet-work-replica`).
5. **fleet replica lane** — pulls a file-level snapshot (SQLite datadir) of
   each bot of a reachable remote site into the board's replica store.
6. **site health monitor** — probes every registered remote site; on a lost
   site decides failover (move bots, drain runs, quarantine); on a returned
   site reconciles containers against the registry.
7. **site scheduler lane** — reads bot cards, sites and affinity rules; the
   pure scheduler verdict moves bots between sites via the fleet move state
   machine, marks pending placements, or does nothing.
8. **chat reconcile fallback** — the safety net of D3: when no chat
   publication or milestone event has fired for 30 s, runs one coalesced
   reconciliation pass to catch anything the event stream missed.

## Raw `setInterval(` and `backgroundInterval(` calls

These are not `laneInterval` calls but are still periodic timers counted by
the ratchet. A full inventory lives in the baseline map inside
`loops-ratchet.myrmidon.test.ts`. Highlights:

- `server/src/app.ts` — feedback-export flush and abandoned-import-spool
  sweep (both gated on `backgroundWorkEnabled`).
- `server/src/index.ts` — closed-task reconcile and backup catch-up (both
  `backgroundInterval`).
- `server/src/myrmidon/bot-containers/fleet-site-routes.ts` — site routes
  poll.
- `server/src/myrmidon/chat-reconciliation/reconcile-interval.ts` — the D3
  fallback timer itself (a `laneInterval` on `chat_reconcile`).
- `server/src/myrmidon/monitoring/board-load/lanes.ts` — the lane
  instrumentation itself (`laneInterval` and `backgroundInterval`
  implementations).
- `server/src/services/chat-channels.ts`, `server/src/services/email-channels.ts`
  — channel lease renewal timers.
- Many more `backgroundInterval` sweeps across `server/src/myrmidon/*` —
  each counted in the ratchet baseline.

## How to add a new timer

1. Add the timer in code.
2. Run
   `pnpm --filter @myrmidon/server exec vitest run src/myrmidon/monitoring/board-load/loops-ratchet.myrmidon.test.ts`
   — it will fail and tell you which file has no baseline record.
3. Add a row describing the loop in this file (and `background-loops.ru.md`).
4. Add the file's counters to `BASELINE` in the ratchet test.
5. Re-run the test — it should be green.

## How to remove a timer

1. Remove the timer in code.
2. Remove the file's row from `BASELINE` (or decrement its counters).
3. Remove the loop's row from this file (and `background-loops.ru.md`).
4. Re-run the ratchet test.

## References

- Design D3 (chats): `docs/myrmidon/DIVERGENCE.md`, section D3.
- Lane definitions: `server/src/myrmidon/monitoring/board-load/lanes.ts`.
- Process-bus channels: `server/src/services/process-bus.ts` (`PROCESS_BUS_CHANNELS`).
- Live-event types: `packages/shared/src/constants.ts` (`LIVE_EVENT_TYPES`).
