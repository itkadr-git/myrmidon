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
| `minFreeMemoryMb` | A run starts only if this much free memory remains in the server's cgroup (v2) after budgeting the run | off |
| `runMemoryEstimateMb` | How many megabytes one run is budgeted at when free memory is counted | `300` |
| `minFreeHostMemoryMb` | A run starts only while the HOST keeps at least this much `MemAvailable` (minus the budget of runs started in the last 30 s). Bots run in their own containers, outside the server cgroup, so `minFreeMemoryMb` cannot see them; this one can | `15360` (15 GB, since 1.6.2) |

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

## The load view (1.6.5)

The same `GET /api/myrmidon/runtime-limits` is also the run-load screen of
the instance: next to the limits themselves it carries three live snapshots,
each read by the same admission that gates on it:

- `queue` — runs in flight against the ceiling, how many wait, and the head
  of the queue with its agent;
- `hostLoad` — the host CPU load the ceiling is measured against;
- `memory` — the memory the memory floors decide on:

```json
"memory": {
  "host": { "availableMb": 21450, "totalMb": 32768 },
  "container": { "limitMb": 4096, "usedMb": 1630, "freeMb": 2466 }
}
```

`memory.host` is the host's `MemAvailable`/`MemTotal` as the host memory
floor reads them (see "The host memory floor" above). `memory.container` is
the server container's own cgroup v2 usage against its limit: `memory.max`
minus `memory.current`, with the reclaimable `inactive_file` page cache
counted as free — the same rule the `minFreeMemoryMb` floor applies. Either
side is `null` when the server cannot read it (no `/proc/meminfo` or a
virtualized one, no cgroup v2 limit), and the whole `memory` block is `null`
on an older server or when the read failed — a consumer shows nothing rather
than a number the server made up. The snapshot only reports; it does not
decide admission.

Both settings panels — Instance → General «Run limits» and Settings →
«Runs & queue» — show the snapshot as a line next to the queue line:

```
Host memory: 21,450 MB available of 32,768 MB. Server container: 1,630 MB
used of 4,096 MB (2,466 MB free).
```

A side the server could not read is simply not mentioned. A changed limit is
visible in the next read of the view, in the snapshot as well as in the
admission — no restart.

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
