# OPE-9934 / OPE-9253: OOM event transport & durable database counter

This document specifies the detection and transport of container Out-Of-Memory (OOM) events across Myrmidon, Dockergate, and fleetd.

## Problem statement & scope (OPE-9934)
Prior Docker inspect polling captured `State.OOMKilled` only when the container's main process (PID 1) died. When a child process (such as a compiler, test runner, or subshell) was killed by the kernel cgroup memory controller (`memory.events oom_kill`), PID 1 remained alive, and `docker inspect` reported `State.OOMKilled == false`. Furthermore, events occurring between reconciliation polls or across rapid container restarts could be lost.

OPE-9934 implements the full event transport:
1. **Dockergate event listener**: A background listener connects to the upstream Docker daemon socket (`/var/run/docker.sock`) filtering for `type=container,event=oom`. It buffers events in a thread-safe ring buffer and exposes them via Route A19 (`GET /myrmidon/events/oom[?since=<nano>]`).
2. **fleetd event listener**: fleetd listens to `/var/run/docker.sock` for `oom` events and inspects cgroup v2 `memory.events oom_kill` on the host, exposing them via `GET /v1/events/oom[?since=<nano>]`.
3. **Child-process OOM capture**: Both PID 1 kills and child-process kills (where PID 1 remains alive) generate kernel OOM events that Docker surfaces via `docker events oom` and cgroup `memory.events oom_kill`.
4. **Agent & run correlation**: Events are tied to the agent by container botKey, and correlated with the heartbeat run active at `occurredAt` (`startedAt <= occurredAt <= finishedAt`). Ambiguous or missing runs are recorded with `runId: null`.
5. **Durable database counter**: Events are recorded in `activity_log` with action `agent.container_oom` and entityType `container_oom`. The durable counter is `countAgentContainerOom(db, agentId, runId?)`, matching the OOM kill records in `journalctl -k`.
6. **Deduplication**: Transactional advisory locks keyed by `containerId:occurredAt:source` prevent duplicate recordings across concurrent reconciliation runs and board restarts.

## Acceptance verification
- Artificial OOM triggered in a test container (e.g. `tail /dev/zero` or Python memory allocation exceeding limit).
- The kernel logs `Memory cgroup out of memory: Killed process` in `journalctl -k`.
- Dockergate / fleetd event transport captures the `oom` event.
- The board records the event in `activity_log`.
- `countAgentContainerOom` matches the number of kernel OOM kills reported by `journalctl -k`.
