# T5 placement planner

`planner.ts` contains the pure T5-A placement decision. It performs no database, network, lane, or move operation.

Input contains the bot resource request, site registry, affinity rules, and optional target IDs. The result is either `{ kind: "selected", siteName, preempt }` or `{ kind: "pending", reason }`.

Selection order is pin, applicable affinity, then capacity. A pinned bot never moves. An unavailable or over-capacity pin returns `pending`. Automatic placement accepts only `available` sites. Capacity accounts for CPU, memory, PIDs, and max bot count. Empty registries and overflow remain explicit pending decisions.

Preemption is disabled unless `allowPreemption` is true. Even then, only a P0 bot may select an available site that lacks free capacity. The planner does not evict or stop a bot; the caller owns that operation.

Local deterministic tie-breaks are intentional implementation rules, not a new product policy: affinity weight wins, then site name in ascending lexical order. The planner is an internal adapter contract. T5 integration should call it before any lane or move action and handle `pending` without silently falling back to local placement.

Addressed tests cover pin preservation, affinity, deterministic ties, CPU/memory/PID/maxBots limits, empty registries, overflow, forbidden statuses, and preemption defaults.
