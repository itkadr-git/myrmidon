# Run admission limits

> Russian version: [run-limits.ru.md](run-limits.ru.md)

The server can bound how many heartbeat runs it starts at once, how fast it
starts them, and how much free memory it keeps. Since release 1.3 these limits
are changeable at runtime: from the UI or the API, without restarting the
server and without interrupting runs that are already in flight.

## The limits

| Setting | What it bounds | Default |
|---|---|---|
| `maxConcurrentRuns` | How many runs this server process may have in flight at once. Runs over the cap stay `queued`; the queue goes oldest first | off |
| `maxStartsPerMinute` | The start ramp: how many runs may start within a sliding minute, whatever woke them | `5` (since 1.6.2; was off) |
| `minFreeMemoryMb` | A run starts only if this much free memory remains in the server's cgroup (v2) after budgeting the run. Since 1.6.5 OWNER-CHAT-ADMISSION this is the floor an answer to a message the owner wrote in a chat is admitted by, applied to the container and to the host's `MemAvailable`: the softer host floor below does not hold it back | off |
| `runMemoryEstimateMb` | How many megabytes one run is budgeted at when free memory is counted | `300` |
| `minFreeHostMemoryMb` | A run starts only while the HOST keeps at least this much `MemAvailable` (minus the budget of runs started in the last 30 s). Bots run in their own containers, outside the server cgroup, so `minFreeMemoryMb` cannot see them; this one can. Since 1.6.5 OWNER-CHAT-ADMISSION it paces the automatic runs only: the owner's own turn in a chat is admitted by `minFreeMemoryMb` (against the host's `MemAvailable` too) and starts while this floor is closed | `15360` (15 GB, since 1.6.2) |

A value of "off" (empty field, `null` in the stored settings) disables that
limit. `runMemoryEstimateMb` cannot be disabled: it is the budget the free-
memory check counts with.

### The host memory floor (1.6.2)

`minFreeHostMemoryMb` reads `MemAvailable` from `/proc/meminfo`. Inside a
Docker container without lxcfs that file is the host's, so the board needs no
mount and no Docker API access. If lxcfs makes the file report the container
limit, the floor refuses the reading, logs `run admission cannot read host
memory…` once and stays inactive; mount the host's `/proc/meminfo` read-only
and set `MYRMIDON_HOST_MEMINFO_PATH` to the mount path.

A run held by the floor stays `queued`; the queue pass retries every 15 s and
the run starts as soon as host memory recovers or the floor is lowered. The
swarm idle-wake pass wakes nobody while the floor is closed. If the floor
holds runs back for more than 10 minutes, the operator gets an attention card
"Runs held: host memory" with the current free memory and the floor; it
disappears with the first admitted run. Lowering the floor (or switching it
off) in the settings releases the queue within a minute, without a restart.

### Who waits at which floor (1.6.5 OWNER-CHAT-ADMISSION)

The floors measure different things, so from 1.6.5 they hold different runs:

- `minFreeHostMemoryMb` and `maxHostLoadPercentPerCore` pace the AUTOMATIC runs
  — schedules, monitors, idle pickup, background follow-ups. A run held by them
  stays `queued` and the queue pass retries it every 15 s, as described above.
- `minFreeMemoryMb` is the hard floor of the server container and, from 1.6.5,
  the ONLY memory floor an answer to a message the owner wrote in a chat is
  admitted by. It is applied twice: to the container's free memory and to the
  host's `MemAvailable` (minus the budget of runs still starting) — the bots
  live outside the container, so the host reading is the one that sees them.
  With the host between `minFreeMemoryMb` and `minFreeHostMemoryMb` the answer
  starts at once while the automatic runs keep waiting; on a host below
  `minFreeMemoryMb` it waits as well.

A turn is recognised by its durable inbound chat receipt (the wake request whose
`idempotencyKey` starts with `chat-inbound:` and whose requester is a board
user) that the queued run points at; the chat's own "retry the failed run"
button and a chat wake opened by a system actor are not the owner's turn. The
sweep sorts such turns ahead of the automatic runs, so a turn that still waits —
only `minFreeMemoryMb` can hold it back — is the first one started, ahead of
every automatic run, whatever task state either has. A turn whose task still
waits for its dependencies keeps its place behind the ready runs.

The whole pipeline keeps naming who waits: the waits of the queued runs still
read `host_memory` / `host_cpu` / `memory`, the operator's attention card and
the "Runs & queue" screen list them, and the chat says a turn is waiting only
while it really waits (i.e. while `minFreeMemoryMb` holds it, on the container
or on the host), and says that the queue is re-checked every 15 seconds.

The idempotency key `chat-inbound:` is reserved for the durable chat receipt:
the public wakeup routes of an agent reject a key that starts with it (`422`).

## Where the effective value comes from

Each limit has one of three sources, shown next to the field in the UI and in
the API response:

- `settings` — the value stored in the instance settings;
- `env` — the environment variable, used as the default on first start;
- `default` — the built-in value (only `runMemoryEstimateMb` has one: 300 MB).

The environment variables are `MYRMIDON_MAX_CONCURRENT_RUNS`,
`MYRMIDON_MAX_RUN_STARTS_PER_MINUTE`, `MYRMIDON_MIN_FREE_MEMORY_MB` and
`MYRMIDON_RUN_MEMORY_ESTIMATE_MB` (see [SETTINGS.md](../SETTINGS.md)). They are
the default for the first start: once the limits are saved from the UI or the
API, the stored settings take over and the variables no longer apply.

## Changing the limits from the UI

Open Instance → General and find the "Run limits" section. The four fields
show the effective values and their sources:

- **Concurrent runs**, **Starts per minute**, **Free memory to keep, MB** —
  enter a whole number greater than zero, or leave the field empty to switch
  the limit off ("No limit").
- **Memory per run, MB** — the budget per run; this field is required and
  cannot be emptied.

Click "Save run limits". A non-whole or non-positive value blocks the save.

## Changing the limits from the API

Read the effective limits and their sources (any authenticated board member):

```sh
curl -H "Authorization: Bearer <token>" http://localhost:3100/api/myrmidon/runtime-limits
```

Write new limits (instance admin only). Send only the keys you change; a key
set to `null` switches that limit off:

```sh
curl -X PATCH \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"maxConcurrentRuns": 8, "minFreeMemoryMb": 2048}' \
  http://localhost:3100/api/myrmidon/runtime-limits
```

A `0`, a negative, a fractional or a non-numeric value, a `null` memory budget
or an unknown key is rejected with `400` and nothing is written.

## What happens after a change

The change is persisted to `instance_settings.general.runLimits`, an activity
row `instance.runtime_limits.updated` with the old and new values is written
for every company, and only then the new limits are applied to the live
admission. Raising a limit also schedules a sweep of the queued runs, so runs
held back by the old cap start within a minute — no server restart, and runs
already in flight are not interrupted. Lowering a limit does not stop running
runs either; it only holds new starts until the count drops below the new cap.

At server start the stored limits are read and applied before the scheduler
starts.

## When the memory check does not apply

If the process cannot see its cgroup memory limit (`memory.max` is `max`, the
host uses cgroup v1, or the server is not in a container), the free-memory
check is inactive and one warning `run admission cannot read the cgroup memory
limit…` is written to the log. The concurrency and start-rate limits still
hold. If the warning is present but the container has a memory limit, check
how the server was started.

## Seeing the admission's refusals (1.6.5)

The Run limits section draws one more line:

```
Admission refusals: 12 since the server started. By reason: concurrency ceiling
x7, start ramp x3, host memory floor x1, memory floor x1. The last refusal: the
start ramp.
```

The total counts the sweeps that left a queued run waiting because of a global
or host ceiling — a run that is merely behind others in the queue is not part
of it. Alongside the total the line shows the breakdown by reason, largest
first, and the reason of the most recent refusal (a reason the screen does not
know is shown under its own name).

The line is fed by `admissionDenials` in the reply of
`GET /api/myrmidon/runtime-limits`. A server that does not send the field (one
older than the change that adds it) draws no line at all — the screen shows
nothing rather than a zero it invented, and the rest of the section is
unaffected.
