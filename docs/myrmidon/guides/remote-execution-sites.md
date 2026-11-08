# Remote Execution Sites: Site-Agent Contract and Operator Guide

> Russian version: [remote-execution-sites.ru.md](remote-execution-sites.ru.md)

This guide specifies the operational architecture, HTTP/JSON wire contract, health/error state machine, and rollout runbook for remote execution sites in Myrmidon 1.6.6 (parent context: OPE-7605).

---

## 1. Architecture Overview

### 1.1 One-Way Management Plane

In Myrmidon, the board running on `vm-core` is the single management plane (`target-architecture.md` §0):
- The central board holds the database, task queue, scheduler, secret store, event journal, and audit log.
- Remote execution sites (such as `myr-vm1`) run dedicated bot execution environments.
- **Directionality invariant**: Control-plane connections are strictly one-way from `vm-core` to the remote execution site over private IPsec / WireGuard networking. The remote site agent holds no board administrator tokens, database access, or reverse credentials into `vm-core`.
- The remote site agent (`fleetd`) listens on a private interface (e.g. `fleetd.internal:9100`), holds the local Docker daemon socket (`/var/run/docker.sock`) of that host, and executes container lifecycle requests strictly within pre-enrolled quotas and image allowlists.

```
+-----------------------------------------------------------------------+
|  vm-core (Central Management Plane)                                   |
|                                                                       |
|  [Reconciler / Scheduler]                                             |
|          |                                                            |
|          v                                                            |
|  [fleetRoutingDriver] ---> local dockerBotContainerDriver             |
|          |                 (dockergate /var/run/dockergate.sock)      |
|          |                                                            |
|          v (HTTP / mTLS + Bearer Token over IPsec)                    |
+----------|------------------------------------------------------------+
           |
           | Private network (e.g. board.internal <-> fleetd.internal)
           v
+-----------------------------------------------------------------------+
|  myr-vm1 (Remote Execution Site)                                      |
|                                                                       |
|  [fleetd / site-agent] (:9100)                                        |
|          |                                                            |
|          +---> local /var/run/docker.sock                             |
|          +---> Bot containers: myrmidon-bot-<botKey>                  |
|          +---> Local volume root: /srv/myrmidon-xfs/myrmidon-bots/    |
|          +---> C-MEM store (hindsight-work / pgvector)                |
+-----------------------------------------------------------------------+
```

---

## 2. Site-Agent API Contract

All calls use HTTPS with mutual TLS and a bearer authorization header:
- The board validates the site's HTTPS URL, CA certificate, client certificate, and client key before creating the transport.
- The client certificate must be signed by the enrolled site CA; the CA fingerprint is checked against the enrollment record.
- `Authorization: Bearer ***` is still required by site-agent after the TLS handshake.
- Missing or invalid certificate material is rejected before the request is sent with a clear configuration error.

Request and response bodies are JSON (`Content-Type: application/json; charset=utf-8`).

### 2.1 Route Catalog

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Signed health snapshot, current epoch, capacity, and active leases |
| `GET` | `/v1/bots` | List all container statuses managed on this site |
| `POST` | `/v1/bots` | Create a container spec (created-but-stopped) |
| `GET` | `/v1/bots/{botKey}/status` | Status, state, hashes, and allocated `gatewayPort` |
| `POST` | `/v1/bots/{botKey}/template-drift` | Verify container inspect against desired spec |
| `PUT` | `/v1/bots/{botKey}/profile` | Upload compiled profile files (`0600`/`0644`), layout to disk |
| `POST` | `/v1/bots/{botKey}/recreate` | Recreate container when template drift is detected |
| `POST` | `/v1/bots/{botKey}/start` | Start container (only after profile written) |
| `POST` | `/v1/bots/{botKey}/restart` | Restart container gateway |
| `POST` | `/v1/bots/{botKey}/stop` | Stop container gateway |
| `GET` | `/v1/bots/{botKey}/logs?tail=N` | Fetch bounded, redacted container stdout/stderr |
| `POST` | `/v1/leases/claim` | Acquire or renew an execution lease with epoch fencing |
| `POST` | `/v1/leases/release` | Explicitly release an execution lease upon task completion |

---

### 2.2 Payload Schemas

#### 2.2.1 `GET /v1/health`

Returns the operational status of the remote site:

```json
{
  "siteId": "myr-vm1",
  "epoch": 14,
  "status": "healthy",
  "capacity": {
    "cpuCores": 16,
    "memoryMb": 65536,
    "diskGb": 500
  },
  "allocated": {
    "cpuCores": 4.5,
    "memoryMb": 18432,
    "pids": 768,
    "containersCount": 3
  },
  "egressCheck": {
    "ok": true,
    "timestamp": "2026-10-17T16:30:00Z"
  },
  "activeLeases": [
    {
      "executionId": "2c277a56-73f0-43da-a3a0-b18b80ffa808",
      "botKey": "work-qa",
      "leaseEpoch": 14,
      "expiresAt": "2026-10-17T16:35:00Z"
    }
  ],
  "version": "1.6.6"
}
```

Fields:
- `siteId` (string, required): Unique identifier of the remote site matching configuration.
- `epoch` (integer, required): Monotonically increasing configuration/fencing generation.
- `status` (string, required): One of `"healthy"`, `"degraded"`, `"unavailable"`, `"fenced"`, `"recovering"`.
- `capacity` (object, required): Available hardware resources provisioned for bot containers.
- `allocated` (object, optional): Sum of active container resource reservations.
- `egressCheck` (object, optional): Connectivity check to central services (LiteLLM, hindsight).
- `activeLeases` (array, optional): Active execution leases currently held on this site.
- `version` (string, optional): Version of site-agent/fleetd software running on the site.

#### 2.2.2 `GET /v1/bots/{botKey}/status`

Reports container state and runtime parameters:

```json
{
  "botKey": "work-qa",
  "state": "running",
  "image": "ghcr.io/itkadr-git/myrmidon-bot@sha256:7f9a8b1c2d3e...",
  "restartHash": "a1b2c3d4e5f6",
  "filesHash": "f6e5d4c3b2a1",
  "gatewayPort": 18642,
  "maxConcurrentRuns": 2
}
```

Fields:
- `botKey` (string, required): Alphanumeric bot identifier (`[a-z0-9-]`).
- `state` (string, required): `"running"`, `"stopped"`, `"missing"`, or `"unhealthy"`.
- `image` (string, optional): Pinned image digest (`image@sha256:...`). Tag references like `:latest` are forbidden.
- `gatewayPort` (integer, optional): The published host TCP port allocated for the bot's Hermes gateway. Used by `fleetGatewayApiBaseUrl` to build the agent card's `apiBaseUrl`.
- `restartHash` (string, optional): Hash of config files that trigger gateway restart when changed.
- `filesHash` (string, optional): Hash of prompt/instruction files.

#### 2.2.3 `POST /v1/bots` and `POST /v1/bots/{botKey}/recreate`

Body specifies container layout:

```json
{
  "spec": {
    "botKey": "work-qa",
    "image": "ghcr.io/itkadr-git/myrmidon-bot@sha256:7f9a8b1c2d3e...",
    "memoryMb": 2048,
    "cpus": 1.5,
    "pidsLimit": 256,
    "network": "myrmidon-bots",
    "extraMounts": [
      {
        "source": "/srv/shared/reference-docs",
        "containerPath": "/shared/docs",
        "readOnly": true
      }
    ],
    "labels": {
      "myrmidon.site": "myr-vm1"
    }
  }
}
```

Constraints:
- `image` must match a pinned `@sha256:` digest listed in the site's `imageAllowlist`.
- `memoryMb`, `cpus`, `pidsLimit` must not exceed the site's enrolled quota for this bot.
- `extraMounts` are read-only by default and must come from the site's `allowedMounts`. A mount without `readOnly: true` is read-write. It is accepted only when its source, with symlinks resolved, is inside one of the site's `writableMountRoots` (see 4.2). Otherwise the request fails with `mount_not_allowed`.
- `cpus` must be at least `0.01`. `gatewayPort`, when set, must be between `1024` and `65535`. `boardExtraHost`, when set, must equal the `boardExtraHost` of the site itself. Otherwise the request fails with `spec_invalid`.
- The rest of the container template is fixed and is not part of the spec: read-only root file system, all capabilities dropped, `/tmp` as a tmpfs, an init process, the `on-failure` restart policy, and no swap beyond the memory limit.

#### 2.2.4 `PUT /v1/bots/{botKey}/profile`

Writes container configuration files prior to starting the gateway:

```json
{
  "profile": {
    "botKey": "work-qa",
    "files": [
      {
        "path": "hermes/config.yaml",
        "content": "api_server:\n  port: 8642\n",
        "mode": 420,
        "secret": false
      },
      {
        "path": "hermes/.env",
        "content": "API_SERVER_KEY=\"<redacted>\"\n",
        "mode": 384,
        "secret": true
      }
    ],
    "restartHash": "a1b2c3d4e5f6",
    "filesHash": "f6e5d4c3b2a1"
  }
}
```

Security enforcement:
- Secret files (`secret: true`) must be written with permissions `0600` (mode 384).
- Secret values are never echoed in response bodies, error messages, or site-agent logs.

#### 2.2.5 `POST /v1/leases/claim`

Acquires an execution lease ensuring no duplicate execution:

```json
{
  "executionId": "2c277a56-73f0-43da-a3a0-b18b80ffa808",
  "botKey": "work-qa",
  "leaseEpoch": 14,
  "ttlSec": 60
}
```

Response:

```json
{
  "acquired": true,
  "leaseEpoch": 14,
  "expiresAt": "2026-10-17T16:31:00Z",
  "fenced": false
}
```

If the site was fenced or the lease epoch is stale:
`{"acquired": false, "leaseEpoch": 14, "expiresAt": "", "fenced": true, "reason": "site_fenced"}`.

---

## 3. Health & Error States

### 3.1 Site State Machine

```
   +-----------+  1-2 probe misses   +------------+
   |  healthy  | ------------------> |  degraded  |
   +-----------+                     +------------+
         ^                                 |
         | probe recovers                  | 3 consecutive misses (90s)
         |                                 v
   +------------+   epoch verify     +---------------+
   | recovering | <----------------- |  unavailable  | (draining)
   +------------+                    +---------------+
         ^                                 |
         |                                 | disconnect > 10m
         | promote / re-arm                v
         +-------------------------- +------------+
                                     |   fenced   |
                                     +------------+
```

1. **`healthy`**:
   - Continuous heartbeats every 30 seconds.
   - Resource reservations within enrolled capacity.
   - Egress probe to LiteLLM / hindsight succeeds.
2. **`degraded`**:
   - 1-2 probe misses or degraded egress latency.
   - Ongoing runs continue; scheduler pauses allocating new batches to this site.
3. **`unavailable`**:
   - 3 consecutive probe misses (90s).
   - Board marks site `draining`. New runs are rejected or held in `pending`.
4. **`fenced`**:
   - Communication severed for > 10 minutes.
   - Management plane increments `siteEpoch`, invalidating active leases.
   - Standby recovery or failover tasks requeue without creating duplicate executions.
   - Site-agent refuses new lease claims until epoch synchronization.
5. **`recovering`**:
   - Site reconnects. Agent validates container digests and volume integrity.
   - Stale orphaned containers are cleaned up.
   - Site transitions back to `healthy` once verified.

---

### 3.2 Error Codes & Reason Codes

Every error response follows single-line, secret-safe reason codes:

| HTTP Status | Reason Code | Description |
|---|---|---|
| `400` | `bad_bot_key` | Bot key does not match regex `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` |
| `400` | `body_not_allowed` | Malformed JSON or unknown fields present |
| `401` | `invalid_token` | Missing, malformed, or mismatching bearer token |
| `401` | `bad_certificate` | mTLS client certificate not issued by site CA |
| `403` | `bot_not_enrolled` | Bot key is not declared in site enrollment table |
| `403` | `limit_exceeds_enrollment` | Spec memory, CPU, or pids exceed enrolled maximums |
| `403` | `image_not_allowed` | Image is not pinned by digest or not allowlisted |
| `403` | `mount_not_allowed` | Extra mount source is not on host allowlist, or a read-write mount is outside every writable root |
| `403` | `spec_invalid` | A spec value is outside the policy: `cpus` below `0.01`, `gatewayPort` outside `1024`-`65535`, or a `boardExtraHost` that differs from the site's |
| `404` | `container_missing` | Target container does not exist on start/restart/stop |
| `409` | `lease_conflict` | Execution lease already held by another execution ID |
| `409` | `epoch_stale` | Provided lease epoch is older than current site epoch |
| `409` | `site_fenced` | Site has been fenced; mutations are locked |
| `429` | `capacity_exhausted` | Insufficient CPU/memory headroom on site |
| `502` | `docker_unreachable` | Site-agent cannot communicate with `/var/run/docker.sock` |

---

## 4. Operator Rollout & Configuration

### 4.1 Prerequisites and site PKI

1. **Host requirements**: a dedicated Linux VM with Docker (e.g. `myr-vm1`). Project-quota XFS at `/srv/myrmidon-xfs` is recommended for per-bot disk limits; on ext4 the quotas are simply absent and `volumeRoot` can point at any directory (e.g. `/srv/myrmidon-bots`).
2. **Network**: the board must reach `fleetd` on its listen address (private LAN or tunnel). Do not publish port `9100` publicly; bind `listen` to the LAN address, not `0.0.0.0`.
3. **Site PKI (mTLS is mandatory)**: `fleetd` serves HTTPS only, requires a client certificate signed by the site CA, and then checks the bearer token on top. It refuses to start without `siteCA`, `serverCert` and `serverKey`. The root site-CA (ECDSA P-256) is generated and stored centrally by the board in company secrets (`myrmidon-site-ca`, 10-year validity, private key never leaves the board). Upon enrollment, the board automatically issues a client certificate (valid 90 days, auto-renewed 30 days before expiration) and a server certificate for fleetd with SAN derived from the site URL. The board also generates the bearer token of the site (random, 64 hex characters; fleetd requires at least 32), stores it in the company secret `myrmidon-fleet-site-token-<site>` and returns it once. The public `ca.crt`, the server certificate and key, and the token are all in the enroll response. The operator prepares no secret: enroll the site first (section 4.3), then configure the site agent with these values (section 4.2).
   The site-CA private key is stored securely in the company and never leaves the board. The enroll response is shown once and carries `Cache-Control: no-store`.

---

### 4.2 Site-Agent Configuration (`myr-vm1`)

Enroll the site first (section 4.3). Copy `ca.crt`, `server.crt` and `server.key` from the enroll response to `/etc/myrmidon/pki/` (key `0600`) and the `fleetd` binary to `/usr/local/bin/fleetd`. Create `/etc/myrmidon/fleetd.json` with permissions `0600`. The file is read with unknown keys rejected, so use exactly these names:

```json
{
  "siteId": "myr-vm1",
  "epoch": 1,
  "listen": "192.0.2.10:9100",
  "token": "<fleetd.token from the enroll response>",
  "upstream": "/var/run/docker.sock",
  "siteCA": "/etc/myrmidon/pki/ca.crt",
  "serverCert": "/etc/myrmidon/pki/server.crt",
  "serverKey": "/etc/myrmidon/pki/server.key",
  "volumeRoot": "/srv/myrmidon-bots",
  "network": "myrmidon-bots",
  "images": ["ghcr.io/itkadr-git/myrmidon-hermes@sha256:*"],
  "allowedMounts": ["/srv/myrmidon-cache"],
  "writableMountRoots": ["/srv/myrmidon-cache"],
  "boardAddress": "192.0.2.1:3100",
  // Legacy hostname stays resolvable as a compatibility alias during rollout.
  "boardExtraHost": "paperclip-server-1:192.0.2.1",
  "gatewayBindIp": "192.0.2.10",
  "gatewayPortStart": 18700,
  "gatewayPortEnd": 18799,
  "bots": [
    { "botKey": "<agent UUID>", "maxMemoryMb": 4096, "maxCpus": 2.0, "maxPids": 512 }
  ]
}
```

Notes: the allowlist key is `images` (not `imageAllowlist`) and only `repo@sha256:*` references are accepted, tags are rejected; without `gatewayPortStart`/`gatewayPortEnd` the port allocator fails with `gateway_port_exhausted`, and without `volumeRoot` creating a bot fails with `volume_root_not_configured`; `boardExtraHost` here is a Docker `ExtraHosts` entry in `name:ip` form, and it is the only board address a container gets: a spec that names a different one is refused with `spec_invalid`; `allowedMounts` lists the host directories that extra mounts may come from; `writableMountRoots` (default: empty) lists the directories in which an extra mount may be read-write, for example shared package caches that are mounted at `/cache/*`. A read-write mount needs both: its source must be inside `allowedMounts` and, with symlinks resolved, inside one of the `writableMountRoots`. Each root must be a clean absolute path, must not be `/`, and must not contain or lie inside `volumeRoot`. Do not nest one writable source below another: a bot with write access to the upper directory can replace the lower one with a symlink, and Docker follows the link at the next start of the container that mounts the lower directory. With the key empty, every extra mount is read-only. The key is new, and a `fleetd` binary from before it rejects it as an unknown key, so roll out the binary first and the configuration second; `bots[]` must not be empty and is static (adding a bot means editing the file and restarting the unit). Validate before starting:

```bash
/usr/local/bin/fleetd --check-config --config /etc/myrmidon/fleetd.json
```

Create systemd unit `/etc/systemd/system/myrmidon-fleetd.service`:

```ini
[Unit]
Description=Myrmidon Fleet Site Agent
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/fleetd --config /etc/myrmidon/fleetd.json
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
systemctl daemon-reload
systemctl enable --now myrmidon-fleetd
```

Verify health with the client certificate (without it the TLS handshake is refused; with it but without the token the answer is `401`):
```bash
curl -s --cacert ca.crt --cert client.crt --key client.key \
  -H "Authorization: Bearer $FLEETD_TOKEN" https://192.0.2.10:9100/v1/health | jq .
```

#### Audit log, limits, client certificate allowlist and hardening

- **Audit log.** fleetd writes one JSON line per API request to stdout, which the journal keeps (`journalctl -u myrmidon-fleetd -o cat | grep '"event":"audit"'`). A line has the time, the route (the bot key is shown as `{botKey}`), the method, `botKey`, the status, `clientCertSha256` and the duration in milliseconds. Bodies, query strings and tokens are not logged. A snapshot that broke off in the middle of the stream is marked `"aborted":true`.
- **Limits.** A JSON request body is limited to 1 MiB. A restore is limited to 20 GiB of file content and 2,000,000 archive entries; above that it answers `413 restore_too_large` and changes nothing. The server limits the time for the request headers (5 s) and for the request (60 s), and it closes idle connections after 2 minutes. A restore upload may pause for up to 2 minutes between two reads. There is no write timeout: a snapshot streams a whole datadir for as long as the board reads it.
- **Clean-up.** The datadirs that a restore or a quarantine moves aside (`.replaced-*` and `.quarantined-*` in `volumeRoot`) are removed after 7 days. The first sweep runs when fleetd starts, then one sweep runs every 24 hours.
- **Client certificate allowlist (optional).** By default fleetd accepts every client certificate that the site CA signed. To allow only some of them, add `"clientCertSha256": ["<64 hex digits>"]` to `fleetd.json`. Each entry is the SHA-256 fingerprint of a client certificate. Colons, upper case and a `sha256:` prefix are accepted. fleetd then refuses any other certificate in the TLS handshake. An empty or missing list keeps the old behaviour. Take the fingerprint from the `clientCertSha256` field of the audit log, or from `openssl x509 -in client.crt -noout -fingerprint -sha256`. A change needs a restart of the unit, and `--check-config` rejects a malformed entry. The board renews its client certificate 30 days before it expires, and the renewed certificate has a new fingerprint. Add the new fingerprint to the list before the board uses the new certificate, or the board loses the site.
- **systemd drop-in.** [`docs/myrmidon/fleetd/myrmidon-fleetd.service.d/hardening.conf`](../fleetd/myrmidon-fleetd.service.d/hardening.conf) adds `ProtectSystem=strict`, a short `CapabilityBoundingSet`, `NoNewPrivileges`, `PrivateTmp` and other sandboxing options to the unit above. Its comments list what fleetd writes and reads. Set `ReadWritePaths` to your `volumeRoot` and install the file in `/etc/systemd/system/myrmidon-fleetd.service.d/`.

---

### 4.3 Board Configuration (`vm-core`): enroll the site

Sites are registered through the board API, no database edits. `MYRMIDON_FLEET_HOSTS` is a legacy bootstrap path that accepts only `http://` addresses and cannot carry mTLS material; do not use it for an mTLS site.

1. Enroll the site (company owner or instance admin only; company admins, members, viewers and agents get `403`). The board generates the bearer token of the site itself. The request never names a secret: a request with `tokenSecret` gets `400`. The host of `url` must be a private IPv4 address (10/8, 172.16/12, 192.168/16, 100.64/10) or a host listed in `MYRMIDON_FLEET_SITE_URL_ALLOWLIST`; any other host gets `400` and the board issues nothing. The address in the example is a documentation address: use the private address of your site.
   ```bash
   curl -sf -X POST "$BOARD/api/companies/$COMPANY/fleet/sites" \
        -H "Authorization: Bearer ***" -H 'content-type: application/json' \
        -d '{
          "name": "myr-vm1",
          "url": "https://192.0.2.10:9100",
          "capacity": { "maxCpus": 4, "maxMemoryMb": 32768, "maxBots": 5 },
          "gatewayPortStart": 18700,
          "gatewayPortEnd": 18799,
          "imageAllowlist": ["ghcr.io/itkadr-git/myrmidon-hermes@sha256:*"],
          "hindsightUrl": "http://hindsight.internal:8890",
          "llmBaseUrl": "http://llm.internal:4000",
          "volumeRoot": "/srv/myrmidon-bots",
          "network": "myrmidon-bots"
        }'
   ```
   The `caCert`, `caFingerprint`, and `clientCertSecretKey` fields are managed automatically by the board and rejected if passed by the client (code `400`). In the `201` response (header `Cache-Control: no-store`), the board returns the public CA certificate (`site.caCert`, `fleetd.caCert`), the issued fleetd server certificate and key (`fleetd.serverCert`, `fleetd.serverKey`) and the generated bearer token (`fleetd.token`). The response is shown once: the operator stores the files on the site at `/etc/myrmidon/pki/` and the token in `fleetd.json` (section 4.2). The board keeps the token in the company secret `myrmidon-fleet-site-token-myr-vm1` and reads it from there. `GET /api/companies/$COMPANY/fleet/sites` lists sites (including the public `caCert` and fingerprint, no private keys, no token); `DELETE /api/companies/$COMPANY/fleet/sites/myr-vm1` (company owner) removes the site with `204` and cleans up the associated client secret and the token secret the board generated. `PATCH /api/myrmidon/fleet/sites/myr-vm1?companyId=$COMPANY` (labels, capacity, address) is owner-only too, and a changed address follows the same host rule. A site enrolled before the board generated tokens keeps its own token secret; nothing changes for it.
2. The gateway port range in the profile mirrors `fleetd.json` for the operator's reference; `fleetd.json` is authoritative.

---

### 4.4 Zero-Downtime Migration Procedure

To migrate bots (e.g. `work-finansist` or `work-qa`) from local or unmanaged manual mode to remote site management without losing sessions, memory, or Telegram webhooks:

1. **Pre-flight verification**:
   - Check site health: `curl --cacert ca.crt --cert client.crt --key client.key -H "Authorization: Bearer ..." https://fleetd.internal:9100/v1/health`.
   - Confirm bind volumes exist at `/srv/myrmidon-xfs/myrmidon-bots/<botKey>/{hermes,workspace,scratch}`.
   - Verify image digest is pinned in CI release manifest (`release-components.json`).
2. **Canary Migration (`work-qa`)**:
   - Edit agent card in board UI or API:
     Set `container.enabled = true`, `container.host = "myr-vm1"`.
   - Reconciler detects host assignment:
     Transitions bot via R3 maintenance window (`pause` -> `drain` -> `writeProfile` -> `start`).
   - The site agent allocates `gatewayPort` (e.g. `18642`), returns status, and card sync updates `apiBaseUrl` to `http://fleetd.internal:18642`.
3. **Verification**:
   - Run a test prompt: verify session continuation and memory recall from local C-MEM.
   - Confirm zero secret leakage in logs.
   - Confirm Telegram bot webhook routing continues undisturbed (board terminates Telegram webhooks on `vm-core`, forwarding turns via Hermes `apiBaseUrl`).
4. **Wave Migration**:
   - Group 1: Idle utility bots.
   - Group 2: Heavy engineering bots.
   - Group 3: Primary operational bot (`work`).
5. **Rollback Runbook**:
   - If an issue occurs during canary, set `container.host = null` or revert card to manual mode (`container.enabled = false`, `apiBaseUrl = "http://fleetd.internal:18642"`).
   - Data volumes on disk are **never deleted** on rollback.

---

### 4.5 Site Memory (C-MEM): hindsight-work on the site, replica on the board

The work-memory of a site is **primary on the site**: its bots recall and retain on the site's own `hindsight-work`, never over the link to the board. The board keeps a replica in the bank `fleet-work-replica`. If the link breaks, bots keep working on local memory; the replica catches up when it is back.

1. **Bring up the memory service** on the site from the canonical compose `docker/site-memory/docker-compose.yml` (`hs-pg` with pgvector, then `hindsight-work`, bound to `127.0.0.1:8890`). Secrets and settings are not in the file: place `profile/hs-pg.env` and `profile/hindsight-work.env` next to it (examples: `*.env.example` next to the compose; rendering them from the site profile on the board is not automated yet), and the images are pinned by digest in `profile/images.env`. `docker compose up` stops when a pin is missing.
   ```bash
   docker compose -f docker-compose.yml --env-file profile/images.env up -d
   docker compose -f docker-compose.yml ps   # hs-pg healthy, hindsight-work running
   ```
2. **Point fleetd at it** with the `memory` object of `fleetd.json`: `{"enabled": true, "url": "http://127.0.0.1:8890", "bank": "<the site's bank>"}`. `POST /v1/memory/recall`, `/v1/memory/retain` and `/v1/memory/export` then work for the bots enrolled on the site.
3. **Turn the sync on at the board, only after the P5 import of step 5** (it runs inside the site-health lane, `MYRMIDON_SITE_HEALTH=1`): `MYRMIDON_FLEET_MEMORY_SYNC=1`, `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL=<the board's hindsight>` and, when it needs one, `MYRMIDON_FLEET_MEMORY_HINDSIGHT_TOKEN`. The replica bank must exist (`fleet-work-replica`, or the bank named by `MYRMIDON_FLEET_MEMORY_REPLICA_BANK`).
4. **What runs**: the lane `myrmidon-memory-sync` copies the site's bank into the replica once a night (after `MYRMIDON_FLEET_MEMORY_SYNC_HOUR_UTC`, 20 by default) with a merge import that skips documents the replica already has; a failed attempt is repeated every 15 minutes until one succeeds. A live bot move runs one more sync right after the source container stops. Every attempt is a row of `myrmidon_fleet_memory_syncs`:
   ```sql
   SELECT site_name, kind, status, documents_imported, documents_skipped, error, started_at
   FROM myrmidon_fleet_memory_syncs ORDER BY started_at DESC LIMIT 20;
   ```
5. **Production import of `fleet-work` / `work` (P5) is a separate manual ADM step**, done in the owner's window, and is **not** run automatically at startup, by the compose, or by the sync lane. Order: (a) bring up the compose (step 1) and check `hs-pg` healthy and `hindsight-work` answering; (b) run the P5 import (export of the banks `fleet-work` and `work` on the board's hindsight, `POST .../transfer/export`, then `POST .../transfer/import?mode=restore` into the site's `hindsight-work`); (c) only then set `MYRMIDON_FLEET_MEMORY_SYNC=1`, so that the first nightly sync does not meet an empty site memory.
