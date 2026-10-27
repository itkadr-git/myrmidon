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
- `extraMounts` are strictly read-only and must be listed in the site's host mount allowlist.

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
| `403` | `mount_not_allowed` | Extra mount source is not on host allowlist |
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
3. **Site PKI (mTLS is mandatory)**: `fleetd` serves HTTPS only, requires a client certificate signed by the site CA, and then checks the bearer token on top. It refuses to start without `siteCA`, `serverCert` and `serverKey`. There is no issuing command in the product; issue the material once per site with `openssl` on a trusted admin host, in a `0700` directory, and never print the key files:
   ```bash
   umask 077; mkdir site-myr-vm1 && cd site-myr-vm1
   # site CA (3 years)
   openssl ecparam -name prime256v1 -genkey -noout -out ca.key
   openssl req -x509 -new -key ca.key -sha256 -days 1095 -subj "/CN=myrmidon-site-ca-myr-vm1" -out ca.crt
   # fleetd server certificate: the SAN must match the host or IP in the enroll `url`
   openssl ecparam -name prime256v1 -genkey -noout -out server.key
   openssl req -new -key server.key -subj "/CN=fleetd-myr-vm1" -out server.csr
   printf "subjectAltName=IP:192.0.2.10\nextendedKeyUsage=serverAuth\n" > server.ext
   openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -sha256 -extfile server.ext -out server.crt
   # board client certificate
   openssl ecparam -name prime256v1 -genkey -noout -out client.key
   openssl req -new -key client.key -subj "/CN=myrmidon-board" -out client.csr
   printf "extendedKeyUsage=clientAuth\n" > client.ext
   openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -sha256 -extfile client.ext -out client.crt
   # bearer token (fleetd requires at least 32 characters)
   openssl rand -hex 32 > token
   cat client.crt client.key > client.pem
   openssl verify -CAfile ca.crt server.crt client.crt
   ```
   Server and client certificates live 365 days and the CA 3 years; rotation is manual (re-issue, replace the files on the site, update the secret value). Keep `ca.key` off the site and off the board.

---

### 4.2 Site-Agent Configuration (`myr-vm1`)

Copy `ca.crt`, `server.crt` and `server.key` to `/etc/myrmidon/pki/` (key `0600`) and the `fleetd` binary to `/usr/local/bin/fleetd`. Create `/etc/myrmidon/fleetd.json` with permissions `0600`. The file is read with unknown keys rejected, so use exactly these names:

```json
{
  "siteId": "myr-vm1",
  "epoch": 1,
  "listen": "192.0.2.10:9100",
  "token": "<contents of the token file>",
  "upstream": "/var/run/docker.sock",
  "siteCA": "/etc/myrmidon/pki/ca.crt",
  "serverCert": "/etc/myrmidon/pki/server.crt",
  "serverKey": "/etc/myrmidon/pki/server.key",
  "volumeRoot": "/srv/myrmidon-bots",
  "network": "myrmidon-bots",
  "images": ["ghcr.io/itkadr-git/myrmidon-hermes@sha256:*"],
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

Notes: the allowlist key is `images` (not `imageAllowlist`) and only `repo@sha256:*` references are accepted, tags are rejected; without `gatewayPortStart`/`gatewayPortEnd` the port allocator fails with `gateway_port_exhausted`, and without `volumeRoot` creating a bot fails with `volume_root_not_configured`; `boardExtraHost` here is a Docker `ExtraHosts` entry in `name:ip` form; `bots[]` must not be empty and is static (adding a bot means editing the file and restarting the unit). Validate before starting:

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
  -H "Authorization: Bearer $(cat token)" https://192.0.2.10:9100/v1/health | jq .
```

---

### 4.3 Board Configuration (`vm-core`): enroll the site

Sites are registered through the board API, no database edits. `MYRMIDON_FLEET_HOSTS` is a legacy bootstrap path that accepts only `http://` addresses and cannot carry mTLS material; do not use it for an mTLS site.

1. Store the secrets in the company (values come from the files, they are never part of the enroll request). Either two secrets `fleetd-myr-vm1-token` (the token) and `fleetd-myr-vm1-client` (`client.pem`: certificate and key PEM blocks, or `{"cert":"...","key":"..."}` JSON), or a pair `fleetd-myr-vm1-client-cert` and `fleetd-myr-vm1-client-key`:
   ```bash
   jq -Rs '{name:"fleetd-myr-vm1-token", value:.}' < token \
     | curl -sf -X POST "$BOARD/api/companies/$COMPANY/secrets" -H "Authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' -d @-
   jq -Rs '{name:"fleetd-myr-vm1-client", value:.}' < client.pem \
     | curl -sf -X POST "$BOARD/api/companies/$COMPANY/secrets" -H "Authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' -d @-
   ```
2. Enroll the site (company owner/admin or instance admin only; viewers, members and agents get `403`). Optionally add `caFingerprint` (sha256 of `ca.crt`, `openssl x509 -in ca.crt -noout -fingerprint -sha256`) to pin the CA:
   ```bash
   jq -n --rawfile ca ca.crt '{
     name: "myr-vm1",
     url: "https://192.0.2.10:9100",
     tokenSecret: "fleetd-myr-vm1-token",
     clientCertSecretKey: "fleetd-myr-vm1-client",
     caCert: $ca,
     capacity: { maxCpus: 4, maxMemoryMb: 32768, maxBots: 5 },
     gatewayPortStart: 18700,
     gatewayPortEnd: 18799,
     imageAllowlist: ["ghcr.io/itkadr-git/myrmidon-hermes@sha256:*"],
     hindsightUrl: "http://hindsight.internal:8890",
     llmBaseUrl: "http://llm.internal:4000",
     volumeRoot: "/srv/myrmidon-bots",
     network: "myrmidon-bots"
   }' | curl -sf -X POST "$BOARD/api/companies/$COMPANY/fleet/sites" \
        -H "Authorization: Bearer $BOARD_KEY" -H 'content-type: application/json' -d @-
   ```
   The request is rejected with `400` when the pinned fingerprint does not match `caCert`, the client certificate in the named secret is not signed by `caCert`, the URL is not `https://host[:port]`, the CA is not a PEM certificate, a named secret does not exist in the company, the port range is inverted or `maxBots` exceeds the number of ports; with `409` when the name is taken. `GET /api/companies/$COMPANY/fleet/sites` lists sites (references and the CA fingerprint, never secret values); `DELETE /api/companies/$COMPANY/fleet/sites/myr-vm1` (admins only) removes one with `204`, or answers `409` while bots (`container.host`) still sit on the site. The board refuses to connect to a site whose stored CA no longer matches the fingerprint recorded at enroll. The board picks the site up within 30 seconds, no restart.
3. The gateway port range in the profile mirrors `fleetd.json` for the operator's reference; `fleetd.json` is authoritative.

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
