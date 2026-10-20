# Bot Memory Limits & OOMKilled Smoke Verification Checklist (1.6.6 / OPE-8425)

## 1. Overview and Purpose

Following memory limit changes across the bot fleet (e.g. alignment from 4GiB to 1GiB per 1.6.6 T4 / OPE-7771 / OPE-8418), this runbook provides a **reproducible, strictly read-only procedure** to verify container memory limits and ensure that no bot has encountered an out-of-memory kill (`State.OOMKilled`).

### Read-Only Invariant Guarantee
- **NO** `docker restart`, `docker stop`, `docker rm`, `docker run`, `docker create`, `docker update`.
- **NO** mutating API calls (`PATCH`, `POST /apply`, etc.).
- The verification operates purely on read-only queries (`docker inspect`, `docker ps`, or static JSON inspect dumps).

---

## 2. Verification Criteria

| Criterion | Target Requirement | Evaluation Method | Failure Threshold |
|---|---|---|---|
| **OOMKilled Status** | `State.OOMKilled == false` | Inspected from Docker container state | Any bot with `true` fails the smoke check |
| **Memory Limit Alignment** | `HostConfig.Memory == targetMemoryBytes` | 1024 MiB (1,073,741,824 B) standard<br>1536 MiB (1,610,612,736 B) hot bots | Any mismatch or `0` (unlimited) fails |
| **Container Status** | `State.Running == true` | Checked for all active container bots | Any unexpected missing or stopped container flagged |
| **Fleet Capacity Safety** | Fleet sum < 68 GiB Host RAM | `65,536 MiB` (64.00 GiB) for 63 bots | Total fleet limits exceed host RAM |
| **Omission Accounting** | Non-container agents tracked | Explicitly listed as `SKIPPED` | Any agent silently omitted |

---

## 3. Standard Execution Checklist

### Phase 1: Pre-Flight Check
- [ ] Confirm target manifest or company agents list is available (`fleet-manifest.json` or `/api/companies/:company_id/agents`).
- [ ] Verify hot bot identifiers:
  - `adm-dev-eng-10` (`887ed69b-5982-4572-a151-f8c809543f29`) -> Target: **1536 MiB**
  - `adm-dev-eng-8` (`90192a57-8b26-4d3f-b65f-bd3fc7feda8b`) -> Target: **1536 MiB**
  - All other container bots -> Target: **1024 MiB**

### Phase 2: Running the Verification Script

#### Option A: Direct Host Execution (Live Docker)
Run directly on the server hosting the bot containers:
```bash
./scripts/myrmidon/deploy/bot-memory-smoke.sh \
  --manifest reports/full-fleet-manifest.json \
  --json-out /tmp/bot-memory-smoke-report.json \
  --table-out /tmp/bot-memory-smoke-report.md
```

#### Option B: Offline Inspection from Pre-Collected Dump
If running in an air-gapped or non-docker container (e.g. engineer development pod or CI):
```bash
# 1. On the host, dump inspect data (read-only):
docker inspect $(docker ps -a -q --filter "name=myrmidon-bot-") > bot-inspect-dump.json

# 2. Run smoke check tool against the dump:
./scripts/myrmidon/deploy/bot-memory-smoke.sh \
  --input bot-inspect-dump.json \
  --manifest reports/full-fleet-manifest.json \
  --json-out bot-memory-smoke-report.json \
  --table-out bot-memory-smoke-report.md
```

#### Option C: Dynamic Board Verification
```bash
./scripts/myrmidon/deploy/bot-memory-smoke.sh \
  --board-url http://127.0.0.1:3100/api \
  --company 2870b911-483a-4091-9f15-183841811143
```

---

## 4. Output Interpretation & Triage

### Verdict Summary
- `PASS [OK]`: All containers are running, `State.OOMKilled` is `false`, and all memory limits match expected targets.
- `FAIL_OOMKILLED`: A bot was killed by the kernel OOM killer (`exit code 137`).
- `FAIL_MEMORY_MISMATCH`: A container is still running with outdated memory (e.g. 4096 MiB or unlimited 0).
- `FAIL_MISSING`: An expected bot container was not found on the host.
- `SKIPPED`: Local or non-container agent (`antigravity_local`, `claude_local`, `openclaw_gateway`), safely accounted for.

### Triage Runbook

#### If `FAIL_OOMKILLED` is observed:
1. Identify the affected bot from the report table.
2. Inspect peak RSS via `docker stats --no-stream` or logs:
   ```bash
   docker logs --tail 200 myrmidon-bot-<agentId>
   ```
3. Evaluate whether the bot is an additional "hot bot" requiring a 1536 MiB limit allocation (adjust manifest and review with Lead/Architect).

#### If `FAIL_MEMORY_MISMATCH` is observed:
1. Verify that the agent card configuration on the board matches:
   ```bash
   curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/agents/<agentId> | jq '.adapterConfig.container.memoryMb'
   ```
2. If the card was updated but the container still has old memory, trigger a reconciler apply cycle (`POST /api/myrmidon/agents/<agentId>/bot-container/apply`) during an approved maintenance window.

---

## 5. Verification Sign-Off Template

```text
Smoke Check Date:       [YYYY-MM-DD HH:MM UTC]
Operator / Verifier:    [adm / operator name]
Release / Context:      1.6.6 T4 Memory Limits Alignment
Total Bots Evaluated:   [66]
Container Bots Checked: [63]
Non-Container Skipped:  [3] (adm-dev-eng-17, bbq-editor-retired, adm2-cli)
State.OOMKilled Status: 0 detected (PASSED)
HostConfig.Memory:      63/63 matched (61 @ 1024 MiB, 2 @ 1536 MiB)
Total Fleet Memory:     65,536 MiB (64.00 GiB) / Host RAM 68.00 GiB
Overall Verdict:        PASSED [OK]
Artifact Attachment:    ope-8425-bot-memory-smoke-sample-report.md
```
