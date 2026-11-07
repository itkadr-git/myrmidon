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
6. **Explicit Gateway Bind IP (No Unspecified Bindings)**: When publishing gateway ports (`gatewayPortStart`/`gatewayPortEnd`), `gatewayBindIp` is mandatory and must be a valid, specific IP address. Binding to unspecified addresses (`0.0.0.0` or `::`) is strictly rejected to prevent exposing gateways on all network interfaces. Two deployment modes are supported:
   - **Local mode** (board and fleetd on the same host): set `gatewayBindIp` to a loopback address (`127.0.0.1` or `::1`, recommended).
   - **Remote mode** (board and fleetd on separate hosts): set `gatewayBindIp` to the dedicated site interface IP (e.g. `192.0.2.10`). The published port must be restricted at the firewall to traffic originating from the board IP; gateway authentication is handled via `adapterConfig.apiKey`.
   If a container requests a gateway port but `gatewayBindIp` is empty, container creation fails closed with `gateway_bind_ip_required`.

## Wire Contract

Refer to [guides/remote-execution-sites.md](guides/remote-execution-sites.md) for the complete API catalog (`/v1/health`, `/v1/bots`, `/v1/bots/{botKey}/status`, `/v1/bots/{botKey}/template-drift`, `/v1/bots/{botKey}/profile`, `/v1/leases/claim`, etc.).
