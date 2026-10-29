# OPE-9253: independent OOM observation boundary (part 1)

This first delivery records Docker-confirmed container OOM termination during the existing inspect/reconcile path. It does not change recovery factory, run status, container limits, or production configuration.

Docker State.OOMKilled and FinishedAt are retained in dockergate's existing trimmed inspect response. Exit 137 alone is never accepted as OOM evidence. Each event is persisted as activity_log action agent.container_oom with container identity, event time, configured memory limit, role, and resource.oom kind. A transaction-scoped advisory lock plus durable event-key lookup prevents duplicates across reconciliation, concurrent workers and board restarts. The durable counter is COUNT(*) of these events, not an in-memory counter. The run association is event-time based, company scoped, and only recorded when exactly one run spans the event; ambiguous/missing runs remain uncorrelated. Peak memory is null rather than fabricated.

## Explicit delivery gates / limitations

Docker inspect does NOT capture child-process cgroup OOM kills while the container's PID 1 remains alive. It may also miss events between polls or after container replacement/restart. Therefore this counter is a lower bound, not the journalctl-equivalent total. A dockergate/fleetd event or cgroup counter transport is tracked in a follow-up subtask.

Recovery factory resource.oom integration, fleet/agent UI, rolling-window thresholds, host-aware memory sizing, and actionable recommendations are tracked in follow-up subtasks; this part 1 PR only establishes the durable observation baseline without relabeling runs or modifying container limits.

The existing affected-test CI lane exercises evidence validation and durable-store boundary behavior (mocked transaction); dockergate's existing Go CI lane exercises trimming.
