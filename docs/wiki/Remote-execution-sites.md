# Remote execution sites

> Russian version: [Remote-execution-sites.ru](Remote-execution-sites.ru)

Remote execution sites run Myrmidon bot containers on dedicated hosts outside
the central board. The board stays the single management plane — database,
task queue, scheduler, secret store, event journal, audit log — while a remote
site-agent (`fleetd`) performs only the enrolled container operations. The
feature ships in 1.6.6.

The authoritative version is the operator guide
`docs/myrmidon/guides/remote-execution-sites.md`
(Russian);
the site-agent's VM-exec details are in
`docs/myrmidon/fleetd-vmexec.md`.
This wiki page condenses them.

## One-way management plane

Control connections go strictly one way, from the board to the site, over a
private IPsec/WireGuard network. The site-agent holds no board administrator
tokens, no database access and no reverse credentials into the board host. It
listens on a private interface (for example `fleetd.internal:9100`), talks to
the local Docker socket only, and executes container lifecycle requests
strictly within the pre-enrolled per-bot quotas (memory, CPU, pids) and the
image allowlist.

Every request carries a bearer authorization header; production deployments
add mTLS with a client certificate issued by the site CA. Request and
response bodies are JSON (`Content-Type: application/json; charset=utf-8`).

## Site-agent API

The contract defines 13 routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Signed health snapshot, current epoch, capacity, active leases |
| `GET` | `/v1/bots` | List the container statuses managed on this site |
| `POST` | `/v1/bots` | Create a container spec (created but stopped) |
| `GET` | `/v1/bots/{botKey}/status` | Status, state, hashes, allocated `gatewayPort` |
| `POST` | `/v1/bots/{botKey}/template-drift` | Compare the container against the desired spec |
| `PUT` | `/v1/bots/{botKey}/profile` | Write the compiled profile files (`0600`/`0644`) |
| `POST` | `/v1/bots/{botKey}/recreate` | Recreate a container when drift is detected |
| `POST` | `/v1/bots/{botKey}/start` | Start the container (only after the profile is written) |
| `POST` | `/v1/bots/{botKey}/restart` | Restart the container gateway |
| `POST` | `/v1/bots/{botKey}/stop` | Stop the container gateway |
| `GET` | `/v1/bots/{botKey}/logs?tail=N` | Fetch bounded, redacted container logs |
| `POST` | `/v1/leases/claim` | Acquire or renew an execution lease with epoch fencing |
| `POST` | `/v1/leases/release` | Release an execution lease on task completion |

The health snapshot carries `siteId`, a monotonically increasing `epoch`, the
`status`, `capacity`, the current `allocated` reservations, an optional
`egressCheck` to central services, `activeLeases` and the fleetd `version`.
Every lease is fenced by the site epoch: when the epoch moves, old leases can
no longer mutate containers.

## Site health states

- `healthy` — heartbeats every 30 s, reservations within enrolled capacity,
  the egress probe succeeds; new work may be placed.
- `degraded` — 1–2 probe misses or degraded egress latency; running work
  continues, the scheduler stops allocating new batches to the site.
- `unavailable` — 3 consecutive probe misses (90 s); the board marks the site
  draining, new runs are rejected or held.
- `fenced` — communication severed for more than 10 minutes; the board
  increments `siteEpoch`, which invalidates the active leases, and the
  site-agent refuses new lease claims until the epochs sync.
- `recovering` — the site reconnects; container digests and volume integrity
  are validated, stale orphaned containers are cleaned up, then the site
  returns to `healthy`.

Every error response uses single-line, secret-safe reason codes — for example
`invalid_token`/`bad_certificate` (401), `bot_not_enrolled`,
`limit_exceeds_enrollment`, `image_not_allowed`, `mount_not_allowed` (403),
`lease_conflict`, `epoch_stale`, `site_fenced` (409), `capacity_exhausted`
(429), `docker_unreachable` (502). The full table is in the operator guide.

## Rollout

1. Prepare a dedicated Linux host (XFS with project quotas for the bot
   volumes), the private tunnel, and a random bearer token stored as a
   company secret on the board.
2. Configure the site-agent in `/etc/myrmidon/fleetd.json` (`0600`): the
   site identity — `siteId` and the starting `epoch` (validated; used for
   lease fencing) — plus the listen address, token, Docker socket, and the
   enrolled bots with their quotas. Port 9100 must not be exposed publicly.
3. On the board, list the site in `MYRMIDON_FLEET_HOSTS`: name, private URL,
   token secret reference, egress endpoints, volume root, network and the
   image allowlist (digest-pinned).
4. Verify `GET /v1/health` locally, then migrate a canary bot: enable the
   container on its agent card and set the site host. The reconciler moves
   the bot through a maintenance window (pause → drain → write profile →
   start) and the site-agent allocates the gateway port.
5. Verify session continuation, memory recall and webhook routing on the
   canary, then migrate the remaining bots in waves.
6. Rollback clears the site host on the card (or disables the container);
   the on-disk data volumes are never deleted on rollback. Removing a site
   means draining its leases and bots first.

The board terminates Telegram webhooks and forwards turns to the bot's
gateway via its `apiBaseUrl`, so webhook routing survives the migration
undisturbed.

## References

Shipped together with the remote execution sites feature (1.6.6):

- `docs/myrmidon/guides/remote-execution-sites.md` (EN) and `.ru.md` (RU) — the operator guide
- `docs/myrmidon/fleetd-vmexec.md` (EN) and `.ru.md` (RU) — the fleetd VM-exec guide
- `server/src/myrmidon/bot-containers/remote-site-contract.ts` — contract parsing and validation
- [`tools/fleetd`](https://github.com/itkadr-git/myrmidon/tree/main/tools/fleetd) — site-agent implementation
