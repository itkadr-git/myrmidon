# Multi-process board mode

> Russian version: [multi-instance.ru.md](multi-instance.ru.md)

By default the Myrmidon board runs as a single OS process: it serves the HTTP
interface on port 3100 and runs every background timer (agent wakes, sweeps,
backups) inside that same process. The multi-process mode — internal name
BOARD-PROCESSES, shipping in 1.6.6 — splits this one process into a *worker*
process that owns all background work and one or more *api* processes that
only serve HTTP. The goal is that a slow deploy, a heavy HTTP spike, or a
crashed request handler never interrupts the background work of the board.

This page explains what the mode is, when to enable it, how to configure it,
and how to watch it while it runs.

## Current state in 1.6.6

The mode is being delivered in parts. As of this writing, the board already
ships:

- the **process registry**: every board process writes a row about itself to
  the `board_processes` table every 10 seconds (role, pid, hostname, version,
  uptime, event-loop lag, resident memory). Rows older than 2 minutes are
  treated as dead and reaped;
- the **«Processes» panel** in the board interface (Instance → General), which
  renders that registry live;
- **`GET /internal/ready`** — the readiness of one process (HTTP 200 when it
  can take traffic, 503 otherwise), with three cheap checks: `database`
  (one `SELECT 1` with a 1-second deadline), `migrations` (boot phase), and
  `bus` (event-bus subscription, reported as `not_applicable` until a process
  uses the bus);
- **`GET /healthz`** — the aggregate verdict for a load balancer. On today's
  single process it reports that process alone (`scope: "process"`). Once the
  process supervisor is in, it answers 200 only when **all** api processes are
  ready (`scope: "supervisor"`, with counters `api: {desired, ready, starting}`,
  the supervisor state, and a machine-readable `reason`).

Still **expected in the release candidate** (not merged to main yet; described
below as designed, per the BOARD-PROCESSES design document):

- the **process supervisor** — the worker forks the api children, they share
  port 3100 via `SO_REUSEPORT`, and the board moves between single and split
  **live, without a container restart**;
- the **`processes` settings key** (`instance_settings.general.processes`) and
  its API `GET`/`PATCH /api/myrmidon/processes`;
- the **`role` label on every metrics family** and the
  **`GET /internal/procs`** endpoint on the metrics router.

Sections that describe the pending parts are marked *«expected in rc»*.

## When to enable it

Stay on the default single process when the board serves a small team and the
host is not CPU-saturated. One process is simpler to reason about, and nothing
in this page changes how it behaves — the default is byte-for-byte the board
as it runs today.

Consider the split when:

- HTTP latency matters during deploys: with several api processes sharing the
  port, a rolling restart of one child does not take the interface down;
- background work (wakes, sweeps, backups) must keep running even when the
  HTTP lane is overloaded or restarting;
- the host has spare cores: the design targets a 4-core container with one
  worker plus two api processes; three api processes is the recommended upper
  bound.

## Roles and ports

| Role | What it does | Listens on |
|---|---|---|
| `all` (default) | Everything: HTTP and all background work | `0.0.0.0:3100` |
| `worker` | All background timers; applies DB migrations; supervises api children | board app on the internal loopback `127.0.0.1:3101` |
| `api` | HTTP only — no background timers at all; waits for the worker to apply migrations instead of migrating itself | `0.0.0.0:3100` (shared between api processes via `reusePort`) |

The role of a process comes from the environment variable
`PAPERCLIP_PROCESS_ROLE` (`all` / `worker` / `api`); an unset or unknown value
falls back to `all` with a warning at startup. Operators normally never set it
by hand: in the supervised layout the worker forks the api children and sets
`PAPERCLIP_PROCESS_ROLE=api` (plus `PAPERCLIP_PARENT_BOOT_ID`) itself.

## Configuration (expected in rc)

The split is configured from the board interface — **Instance → General →
«Processes of the board»** — or through the API. The values live in
`instance_settings.general.processes`:

| Key | Values | Default | Meaning |
|---|---|---|---|
| `mode` | `single`, `split` | `single` | One process does everything, or worker + api processes |
| `apiCount` | 1–4 | 1 | How many api processes `split` runs |
| `leaderLeaseTtlSec` | 5–600 | 30 | Leader lease TTL of the background role |
| `liveEventsBus` | `local`, `pg` | `local` | How live events travel between processes |
| `admissionStore` | `memory`, `db` | `memory` | Where run admission is decided |
| `singletonProxy` | boolean | `true` | A non-leader process proxies single-process routes to the leader |

Read the effective values and the source of each (`settings` / `env` /
`default`), plus the mode this build actually honours:

```sh
curl -s http://localhost:3100/api/myrmidon/processes
```

Change the mode (instance-admin only; applies live, without a container
restart):

```sh
curl -s -X PATCH http://localhost:3100/api/myrmidon/processes \
  -H 'Content-Type: application/json' \
  -d '{"mode": "split", "apiCount": 2}'
```

**Emergency escape hatch.** `PAPERCLIP_PROCESS_MODE=single` in the environment
wins over the saved setting and is read at startup, before the database: if a
saved row ever takes the board down, start the container with this variable
set and the board comes up as one process, so you can fix the setting from
the interface. The settings page shows the forced mode with source `env`
while the variable is set.

## Watching the processes

### The «Processes» panel

Instance → General shows every live board process: boot id (the row written by
the process serving the page is marked «self»), role, pid and hostname,
container id, api port, version, uptime, pulse age, event-loop lag, and
resident memory. The panel polls at the registry cadence, so a process that
dies turns amber within one pulse tick (10 s) and disappears within the
staleness window (2 minutes).

### The registry API

The same data over the API (any board member may read it):

```sh
curl -s http://localhost:3100/api/myrmidon/board-processes
```

The answer carries `pulseSeconds`, `staleAfterSeconds`, and one entry per
process with `status: "live" | "stale"`.

### /internal/procs (expected in rc)

The metrics router gets `GET /internal/procs`, guarded by the same bearer
token as the metrics endpoint (`MYRMIDON_METRICS_TOKEN` or the company secret
named by `MYRMIDON_METRICS_TOKEN_SECRET`). It lists the board processes from
the registry — role, pid, `startedAt`, `uptimeSeconds`, `ready` — and names
the role of the answering process:

```sh
curl -s -H "Authorization: Bearer $MYRMIDON_METRICS_TOKEN" \
  http://localhost:3100/internal/procs
```

A failed registry read still answers HTTP 200 with a well-formed empty list,
so a poller during a database outage gets data-shaped silence, not an error
page.

### Metrics by role (expected in rc)

Every sample line of every metrics family carries the label
`role="api|worker|all"`, resolved the same way as the process registry
(`PAPERCLIP_PROCESS_ROLE`, default `all`). Metric names do not change; the one
colliding queue-family label was renamed `role` → `assignee_role`. Per-role
scraping answers «is the HTTP lane slow, or the scheduler?» without log
diving.

### Readiness probes for the balancer

Point the load balancer or container runtime at:

- `GET /healthz` — the aggregate: 200 only when the board as a whole can take
  traffic. During a transition into split (`supervisorState:
  "startingSplit"`) it answers 503 by definition, so the balancer waits for
  every api child instead of sending traffic to a half-built layout;
- `GET /internal/ready` — one process about itself; use it for per-process
  checks (role, boot id, per-check detail) when debugging.

Both endpoints set `Cache-Control: no-store`, read no credentials, and expose
no company data.

## Deploys and drain (expected in rc)

Switching modes never needs a container restart — the supervisor moves the
board live:

- **single → split**: the worker forks the api children but keeps serving
  :3100 itself until *every* child has reported `ready` over IPC (a child
  reports ready only after its listener is up and a `SELECT 1` succeeds).
  Then the worker closes its own public listener. `/healthz` reads 503 with
  `reason: "split_starting"` for the whole transition.
- **split → single**: the worker re-opens :3100 (with `reusePort`, so the
  children keep serving in the meantime) and then *drains* the children one
  by one.
- **Scale up/down** (`apiCount` change) follows the same readiness gate.

A drain is how a child leaves without dropping requests:

1. The worker sends `drain` over IPC.
2. The child stops accepting new connections (`server.close()`), closes idle
   ones, and closes live-events websocket clients with code 1012 so they
   reconnect to a surviving process.
3. After a 30-second grace period it closes whatever is still open
   (`closeAllConnections()`) and exits cleanly.

Crash handling: a dead api child is restarted on a backoff ladder (1 s,
doubling up to 30 s). If no live api child remains for 15 seconds, the worker
re-opens :3100 itself (*emergency return to single*) and raises the attention
signal — the board stays up even if every child is broken. Each api child
gets a 1 GiB heap ceiling (`--max-old-space-size`), so a runaway request
handler cannot starve the worker.

Container deploys: keep pointing the container health check at `/healthz`.
Because the aggregate is 503 while a split is starting or a drain is in
flight, an orchestrator that honours the probe will not cut over to a new
container until the new layout is actually serving, and will not kill the old
one mid-drain.

## Source pointers

- Registry and panel: `server/src/myrmidon/process-registry/`,
  `ui/src/components/myrmidon/BoardProcessesSettingsPanel.tsx`
- Readiness: `server/src/myrmidon/process-readiness/`
- Supervisor and settings (pending merge):
  `server/src/myrmidon/processes/`,
  `packages/shared/src/myrmidon-processes.ts`
- Role resolution today: `server/src/myrmidon/process-registry/domain.ts`
  (`resolveBoardProcessRole`); the dedicated role-gate module
  (`server/src/services/process-role.ts`) lands with the supervisor.
- Metrics label and `/internal/procs` (pending merge):
  `server/src/myrmidon/monitoring/metrics/`
