# T5 placement planner

`planner.ts` contains the pure T5-A placement decision. It performs no database, network, lane, or move operation.

Input contains the bot resource request, site registry, affinity rules, and optional target IDs. The result is either `{ kind: "selected", siteName, preempt }` or `{ kind: "pending", reason }`.

Selection order is pin, applicable affinity, then capacity. A pinned bot never moves. An unavailable or over-capacity pin returns `pending`. Automatic placement accepts only `available` sites. Capacity accounts for CPU, memory, PIDs, and max bot count; malformed/non-finite or negative resource snapshots are ineligible. Empty registries and overflow remain explicit pending decisions.

Preemption is disabled unless `allowPreemption` is true. Even then, only a P0 bot may select an available site with supplied `preemptibleBots` evidence. Each evidence item must identify a low-priority victim and its CPU, memory, and PID requests; aggregate reclaimed resources plus one freed bot slot must make the placement fit every capacity dimension. High/P0 victims, absent evidence, and malformed snapshots remain pending. Evidence must reflect a consistent current allocation snapshot. The planner does not evict or stop a bot; the caller owns that operation.

Resource units: `cpus` is the scheduler's CPU allocation unit (must use the same unit for requests, capacity, and allocated totals); `memoryMb` is MiB; `pids` is process count; `bots` and `maxBots` are bot counts. `allocated` is current aggregate usage, and fit means `allocated + request <= capacity` independently for CPU, memory, PIDs, and `allocated.bots + 1 <= maxBots`. Preemption subtracts only verified victim requests/counts before applying the same test.

Local deterministic tie-breaks are intentional implementation rules, not a new product policy: applicable affinity matches outrank sites without affinity, greater non-negative weight wins, and equal scores resolve by site name in ascending lexical order. Invalid affinity weights are ignored. The planner is an internal adapter contract. T5 integration should call it before any lane or move action and handle `pending` without silently falling back to local placement.

Addressed tests cover pin preservation, affinity, deterministic ties, CPU/memory/PID/maxBots limits, empty registries, overflow, forbidden statuses, and preemption defaults.
