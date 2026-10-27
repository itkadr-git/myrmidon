# OPE-9253: independent OOM observation boundary

This first delivery records Docker-confirmed container OOM termination during the existing inspect/reconcile path. It does not change recovery factory, run status, container limits, or production configuration.

Docker State.OOMKilled and FinishedAt are retained in dockergate's existing trimmed inspect response. Exit 137 alone is never accepted as OOM evidence. Each event is persisted as activity_log action agent.container_oom with container identity, event time, configured memory limit, role, resource.oom kind and recommendation. A transaction-scoped advisory lock plus durable event-key lookup prevents duplicates across reconciliation, concurrent workers and board restarts. The durable counter is COUNT(*) of these events, not an in-memory counter. The run association is event-time based, company scoped, and only recorded when exactly one run spans the event; ambiguous/missing runs remain uncorrelated. Peak memory is null rather than fabricated.

## Explicit delivery gates / limitations

Docker inspect does NOT capture all child-process cgroup OOM kills while the container's PID 1 remains alive. It may also miss events between polls or after container replacement/restart. Therefore this counter is a lower bound, NOT the journalctl-equivalent total. A dockergate/fleetd event or cgroup counter transport is still needed before full-task acceptance.

Recovery factory resource.oom integration remains OPE-8337's gate; this PR does not relabel interrupted runs. Fleet/agent UI, rolling-window thresholds, host-aware memory sizing and confirmed recommendation application are not delivered here. Recommendation is evidence-only; no automatic or one-click limit change is enabled.

The focused CI workflow exercises evidence validation, durable-store boundary behavior (mocked transaction), and dockergate trimming. It is NOT a real database concurrency test or an artificial-container-OOM integration test. Those remain acceptance gates; no skipped/mock test is claimed as production acceptance.

ADM: after full event transport and recovery integration land, run an isolated artificial OOM container, verify event/run/recommendation linkage, then compare event totals with journalctl -k over the same window. No production limits should be changed for this check.
