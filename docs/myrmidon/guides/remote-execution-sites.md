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

All calls use standard HTTP over private network with a bearer authorization header:
`Authorization: Bearer <SITE_TOKEN>`.
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

### 4.1 Prerequisites

1. **Host requirements**: Dedicated Linux VM (e.g. `myr-vm1`, 16+ cores, 64 GB RAM, XFS filesystem with project quotas enabled at `/srv/myrmidon-xfs`).
2. **Network**: IPsec tunnel between `vm-core` (`board.internal`) and `myr-vm1` (`fleetd.internal`). No public exposure of port `9100`.
3. **Certificates & Tokens**: Generate a 64-character random token and store it as a company secret on the board:
   ```bash
   TOKEN=$(openssl rand -hex 32)
   ```

---

### 4.2 Site-Agent Configuration (`myr-vm1`)

Create `/etc/myrmidon/fleetd.json` with permissions `0600`:

```json
{
  "siteId": "myr-vm1",
  "epoch": 1,
  "listen": "0.0.0.0:9100",
  "token": "<TOKEN>",
  "upstream": "/var/run/docker.sock",
  "bots": [
    {
      "botKey": "work-qa",
      "maxMemoryMb": 4096,
      "maxCpus": 2.0,
      "maxPids": 512
    },
    {
      "botKey": "work-finansist",
      "maxMemoryMb": 4096,
      "maxCpus": 2.0,
      "maxPids": 512
    }
  ]
}
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

Verify local health:
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://fleetd.internal:9100/v1/health | jq .
```

---

### 4.3 Board Configuration (`vm-core`)

On `vm-core`, configure `MYRMIDON_FLEET_HOSTS` in `/etc/myrmidon/board.env` (or via Company Secrets and Settings):

```json
MYRMIDON_FLEET_HOSTS='[
  {
    "name": "myr-vm1",
    "url": "http://fleetd.internal:9100",
    "tokenSecret": "fleetd-myr-vm1-token",
    "hindsightUrl": "http://hindsight.internal:8890",
    "llmBaseUrl": "http://llm.internal:4000",
    "boardExtraHost": "paperclip-server-1",
    "volumeRoot": "/srv/myrmidon-xfs/myrmidon-bots",
    "network": "myrmidon-bots",
    "imageAllowlist": ["ghcr.io/itkadr-git/myrmidon-bot@sha256:*"]
  }
]'
```

Register the company secret `fleetd-myr-vm1-token` containing the shared secret token.

---

### 4.4 Zero-Downtime Migration Procedure

To migrate bots (e.g. `work-finansist` or `work-qa`) from local or unmanaged manual mode to remote site management without losing sessions, memory, or Telegram webhooks:

1. **Pre-flight verification**:
   - Check site health: `curl -H "Authorization: Bearer ..." http://fleetd.internal:9100/v1/health`.
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
