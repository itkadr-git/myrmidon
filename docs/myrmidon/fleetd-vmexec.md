# fleetd: Remote Bot Container Site Daemon

> Russian version: [fleetd-vmexec.ru.md](fleetd-vmexec.ru.md)
> Detailed operator runbook: [guides/remote-execution-sites.md](guides/remote-execution-sites.md)

`tools/fleetd` is the lightweight remote execution daemon running on secondary hosts (e.g. `myr-vm1`).
It executes the board's `BotContainerDriver` interface locally against the Docker daemon socket (`/var/run/docker.sock`), providing isolation, strict quota enforcement, template-drift detection, and execution fencing.

## Implementation Principles

1. **Standard Library Only**: `tools/fleetd` has zero third-party dependencies (`go.mod` is stdlib-only).
2. **Fixed Template & Quotas**: Every bot must be pre-enrolled in `bots[]` with positive `maxMemoryMb`, `maxCpus`, and `maxPids`. Specs requesting resources over enrolled maximums are rejected (`limit_exceeds_enrollment`).
3. **Digest-Only Images**: Only pinned digests (`image@sha256:...`) matching `imageAllowlist` are accepted. Tags such as `:latest` are rejected at admission.
4. **Zero-Secret Visibility**: Secrets are delivered in profile payloads and written directly to files with mode `0600`. Secrets are never echoed back in inspect, status, or log streams.
5. **Epoch Fencing**: Leases are acquired with explicit lease epochs, preventing duplicate task executions when network partitioning occurs.

## Wire Contract

Refer to [guides/remote-execution-sites.md](guides/remote-execution-sites.md) for the complete API catalog (`/v1/health`, `/v1/bots`, `/v1/bots/{botKey}/status`, `/v1/bots/{botKey}/template-drift`, `/v1/bots/{botKey}/profile`, `/v1/leases/claim`, etc.).
