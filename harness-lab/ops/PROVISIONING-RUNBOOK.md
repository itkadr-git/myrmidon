# Harness-lab provisioning runbook (operator-only)

Audience: the board operator (ADM) who owns the `myr-dev-build` host. Nobody else
executes this runbook. Engineering delivers this document and the rubric template;
every live step below needs host access that engineering containers deliberately do
not have (no Docker daemon, no host shell).

This runbook provisions the isolated harness board for the harness-lab live
acceptance: a second Myrmidon instance with its own datastore, its own scoped
credential, an operator-only acceptance rubric, and one approved runner command.
At the end, all five harness acceptance items have a concrete proof command.

Non-negotiables (company rules that apply on this host):

- Only images built by CI are run. Resolve and pin the digest of
  `ghcr.io/itkadr-git/myrmidon` first (step 2). No `docker build` on this host,
  no local tags, no `:main`/`:latest` (owner decision of 29.09.2026).
- Never point the harness at the production Paperclip board. The production API is
  not a harness target, and its URL must not appear in any executor task
  description.
- Never write credential values, hostnames, or the rubric contents into git, the
  issue thread, or an executor-visible path.

## 0. What you need before starting

- SSH to the `myr-dev-build` host with docker compose v2 (`docker compose version`)
  and a psql client matching PostgreSQL 18.
- A clone of `itkadr-git/myrmidon` on the host (any recent `main` checkout is fine;
  it is used to verify the image commit, not to run from).
- The harness-lab runner: `harness-lab/run.py` and `harness-lab/manifest.json` from
  the same clone (the five reference scenarios).
- The rubric template from this directory: `ops/acceptance-rubric.template.json`.
- Outbound reachability from the host to the model provider used by the runner
  profile (step 8), and a free TCP port — this runbook uses `3200`.

## 1. Isolated datastore (not the production company's database)

Pick one profile; either satisfies "isolated datastore". Do not reuse the
production board's database, role, or volume.

Profile A — dedicated database and role on the host's shared PostgreSQL 18
(matching how production boards can share one PG server with their own DB):

```sh
# Names are harness-lab specific; do not reuse production role/db names.
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE harness_lab LOGIN PASSWORD '<generate: openssl rand -base64 24>';
CREATE DATABASE harness_lab OWNER harness_lab;
REVOKE ALL ON DATABASE harness_lab FROM PUBLIC;
SQL
```

Profile B — a dedicated PostgreSQL container owned by the harness compose project
(the compose file in step 3 includes this as the default `harness-db` service, so
no manual SQL is needed; the volume `harness_pgdata` is the isolation boundary).

Verify isolation either way:

```sh
# The harness database lists zero harness companies before first boot,
# and shares nothing with the production database:
psql -h 127.0.0.1 -U harness_lab -d harness_lab -c '\dt'   # Profile A: empty initially
docker volume ls | grep harness_pgdata                      # Profile B: dedicated volume
```

Record which profile you used in the completion comment on the harness task.

## 2. Pin the CI-built image digest

Resolve the digest of a CI-built image whose commit is on `main` (or a `myr-v*`
tag) — never a movable tag:

```sh
git -C /path/to/myrmidon-clone fetch origin main
DIGEST=$(docker buildx imagetools inspect ghcr.io/itkadr-git/myrmidon:main-sha-<short> --format '{{json .Manifest.Digest}}')
# resolve <short> from the newest green main build of the Myrmidon image workflow
echo "ghcr.io/itkadr-git/myrmidon@$DIGEST"
```

Verify the CI provenance before using it (deploy.sh applies the same four checks;
do the equivalent by hand here):

```sh
docker buildx imagetools inspect "ghcr.io/itkadr-git/myrmidon@$DIGEST" --format '{{json .Image.Labels}}'
# require: org.opencontainers.image.revision = a full commit sha that
#          `git -C /path/to/clone merge-base --is-ancestor <sha> origin/main` accepts
#          (or the commit carries a myr-v* tag),
#          org.opencontainers.image.source = https://github.com/itkadr-git/myrmidon
```

If any check fails, pick another digest. There is no bypass, and the rule is the
same as production: an image that is not from CI never boots here.

## 3. Second instance: compose definition

Create `/srv/harness-lab/docker-compose.harness-lab.yml` on the host. This is a
separate compose project (its own network and volumes); it never edits the
production stack's files:

```yaml
# /srv/harness-lab/docker-compose.harness-lab.yml
# Isolated harness board (myr-dev-build). Project name: harness-lab.
services:
  harness-db:
    image: docker.io/pgvector/pgvector:pg18
    secrets:
      - db_credential_file
    environment:
      POSTGRES_USER: harness_lab
      POSTGRES_PASSWORD_FILE: /run/secrets/db_credential_file
      POSTGRES_DB: harness_lab
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harness_lab -d harness_lab"]
      interval: 2s
      timeout: 5s
      retries: 30
    volumes:
      - harness_pgdata:/var/lib/postgresql
    # No ports: section on purpose. The database is reachable only on the
    # harness-lab compose network.

  harness-board:
    image: ghcr.io/itkadr-git/myrmidon@sha256:REPLACE_WITH_DIGEST_FROM_STEP_2
    pids_limit: 2048
    ports:
      # Loopback only. Reachable on the host as http://127.0.0.1:3200;
      # expose to the runner's address explicitly, never 0.0.0.0.
      - "127.0.0.1:3200:3200"
    environment:
      # Connection to the harness-db service. Compose interpolates the DSN from
      # the 0600 harness.env file (see HARNESS_DB_DSN below); this YAML never
      # contains credential material.
      DATABASE_URL: "${HARNESS_DB_DSN}"
      PORT: "3200"
      SERVE_UI: "true"
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated"
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private"
      PAPERCLIP_PUBLIC_URL: "http://127.0.0.1:3200"
      # Instance auth signing key. The server reads the container variable by
      # its exact configured name (BETTER_AUTH_SECRET — see server/src/auth/
      # better-auth.ts and .env.example); the value comes from harness.env via
      # compose interpolation and is unique to this instance.
      BETTER_AUTH_SECRET: "${HARNESS_BETTER_AUTH_SECRET}"
    volumes:
      - harness-board-data:/paperclip
    depends_on:
      harness-db:
        condition: service_healthy

volumes:
  harness_pgdata:
  harness-board-data:

secrets:
  db_credential_file:
    file: ./secrets/db_credential.txt
```

The `harness-db` service reads its credential from the compose secret mount
(`/run/secrets/db_credential_file`), so no credential value appears in this file;
generate the credential file next to the compose file instead:

```sh
# /srv/harness-lab/secrets/db_credential.txt  (chmod 600, one line, no trailing newline)
openssl rand -base64 24 > /srv/harness-lab/secrets/db_credential.txt
chmod 600 /srv/harness-lab/secrets/db_credential.txt
```

The board service takes its interpolated values from the environment file below;
`docker compose` interpolates `${...}` from `--env-file` at up time and the
values never land in this YAML or in git.

The auth secret lives in the operator-only env file (mode `0600`, owned by the
operator account, never committed anywhere):

```sh
# /srv/harness-lab/harness.env  (chmod 600)
# generate once; the db credential value must match secrets/db_credential.txt.
# The DSN is composed from the parts (user, credential from the secrets file,
# db name); paste the assembled value here:
# HARNESS_DB_DSN=postgres://<user>@harness-db:5432/<db>
# HARNESS_BETTER_AUTH_SECRET=$(openssl rand -base64 48)   # unique to this instance;
# this exact name is what the compose file interpolates into BETTER_AUTH_SECRET.
```

Bring the stack up and prove it is the new instance, not production:

```sh
cd /srv/harness-lab
docker compose --project-name harness-lab --env-file harness.env \
  -f docker-compose.harness-lab.yml up -d
curl -fsS http://127.0.0.1:3200/api/health | jq '{status, commit, version}'
```

Expected: `commit` equals the `org.opencontainers.image.revision` you pinned in
step 2 (a commit on `main`), and the instance has no relation to the production
board: different port (3200 vs the production board's port), different datastore, different
auth signing key.

## 4. Isolation proof (acceptance item 1)

Collect and keep these outputs for the harness task completion comment:

```sh
# (a) The harness board serves its own datastore:
docker compose --project-name harness-lab exec -T harness-db \
  psql -U harness_lab -d harness_lab -c 'select current_database(), current_user;'

# (b) Fresh instance: no pre-existing companies from production leaked in.
#     Sign-up is open on a fresh authenticated instance; complete onboarding once
#     (step 5) and this company must be the ONLY one:
curl -fsS http://127.0.0.1:3200/api/health >/dev/null && echo "board up"

# (c) The production board still answers on its own port and is a different
#     instance (different commit or different datastore identity). Do NOT use its
#     URL anywhere below.
```

Negative probe 1 of 2 — the runner must refuse the production URL. Run from any
machine with the repo checkout:

```sh
HARNESS_LAB_BOARD_URL="<production Paperclip API base URL>" \
HARNESS_LAB_RUBRIC_PATH=/tmp/unused.json \
python3 harness-lab/run.py --profile hermes-gateway --report /tmp/probe-prod.json
# Expected output:
#   harness-lab: production-looking board URL rejected
# and exit code 1 (run.py refuses private/loopback hosts and prod markers).
```

If instead the runner had accepted the URL, the harness would be unusable; stop
and fix before continuing.

## 5. Scoped credentials limited to the harness board (acceptance item 2)

Create a harness-only identity on the harness board itself, so its key cannot
reach any other company or instance:

1. Open `http://127.0.0.1:3200` once and complete onboarding. Name the company
   `harness-lab` (this company exists only in the `harness_lab` datastore).
2. In the board UI: create an agent member for the runner (for example
   `harness-runner`), then create its agent API key (agent keys are hashed at
   rest and are company-scoped by design — a key cannot read or mutate another
   company).
3. Store the key in `/srv/harness-lab/harness-runner.env` (mode `0600`, not in
   git, not in the issue thread):

   ```sh
   # /srv/harness-lab/harness-runner.env  (chmod 600)
   HARNESS_LAB_BOARD_URL=http://127.0.0.1:3200/api
   # read HARNESS_LAB_BOARD_TOKEN from the runner agent API key (never inline it)
   HARNESS_LAB_RUBRIC_PATH=/srv/harness-lab/private/acceptance.json
   ```

4. Verify the scoping — the key works on the harness company and is worthless
   elsewhere:

```sh
set -a; . /srv/harness-lab/harness-runner.env; set +a
# Works against the harness board (200) — agent keys are scoped to their company:
curl -fsS -H "Authorization: Bearer $HARNESS_LAB_BOARD_TOKEN" \
  "$HARNESS_LAB_BOARD_URL/agents/me" | jq '{id, companyId, name}'
# If any second Paperclip instance is reachable for a negative check, the same
# request there must fail 401/403. That cross-check output also goes in the comment.
```

Rotate this key after the live run window ends (step 11).

## 6. Operator-only rubric path (acceptance item 4)

Install the rubric from the template delivered in this directory. The rubric
holds the expected outcomes; executors must never be able to read it (otherwise
repeated runs are invalid — the agent would "find the rubric").

```sh
mkdir -p /srv/harness-lab/private
# Copy ops/acceptance-rubric.template.json from the repo, then edit
# expected_status and expected_signals per scenario if the operator's judgment
# differs; the runner reads expected_status + expected_signals from this file
# after the run.
python3 - <<'PY'
import json
t = json.load(open("acceptance-rubric.template.json"))
out = {
    s["id"]: {
        "status": s["expected_status"],
        "expected_status": s["expected_status"],
        "expected_signals": s.get("expected_signals", {}),
    }
    for s in t["scenarios"]
}
json.dump(out, open("/srv/harness-lab/private/acceptance.json", "w"), indent=2)
print("scenarios:", len(out))
PY
chown -R root:harness-runner /srv/harness-lab/private
chmod 750 /srv/harness-lab/private          # traverse only for the group
chmod 640 /srv/harness-lab/private/acceptance.json   # runner group reads, others denied
```

Create the `harness-runner` group and put the runner OS account in it (the
account that will execute step 8); the executor agent's OS account is NOT in this
group.

Negative probe 2 of 2 — executor cannot read the rubric:

```sh
# As the OS account that runs the executor agent (not the runner account):
sudo -u <executor-os-user> cat /srv/harness-lab/private/acceptance.json
# Expected: "Permission denied" (exit 1). Keep the output for the comment.
sudo -u <runner-os-user> cat /srv/harness-lab/private/acceptance.json | head -3
# Expected: JSON content (the runner CAN read it). Keep the output for the comment.
```

`run.py` reads the rubric only for post-run validation (`rubric_check` in the
report); it is never sent to the executor and never appears in a task prompt.

## 7. Approved runner command (acceptance item 3)

The approved profile and command are exactly this (no other runner path is
approved for the live run):

```sh
cd /path/to/myrmidon-clone        # the checkout that carries harness-lab/
set -a; . /srv/harness-lab/harness-runner.env; set +a   # runner-only, 0600
python3 harness-lab/run.py \
  --profile hermes-gateway \
  --report /srv/harness-lab/report.json
```

Env contract (all three are required by `run.py`; it refuses to start without
them):

| Variable | Meaning | Set by |
|---|---|---|
| `HARNESS_LAB_BOARD_URL` | Harness board API base, `http://127.0.0.1:3200/api` | operator env file |
| `HARNESS_LAB_BOARD_TOKEN` | Scoped agent API key from step 5 | operator env file |
| `HARNESS_LAB_RUBRIC_PATH` | `/srv/harness-lab/private/acceptance.json` | operator env file |

`--profile hermes-gateway` names the profile the board runs the scenarios with;
the profile must exist on the harness board (configure it in the board UI before
the run). Do not pass any production URL or token to this command. Do not put the
rubric path or board URL into any executor task description — executor-visible
prompt is exactly what acceptance item 4 forbids.

## 8. Run and report (acceptance item 5)

Execute the approved command from step 7. `run.py` writes the report and prints a
one-line summary. Pass the report only if every check below holds:

- `scenario_count >= 5` (the manifest's five scenarios: review-gate-bypass,
  blocked-without-reason, ci-wait-no-monitor, idle-run, normal-control);
- `demonstration_count >= 2` (at least two scenarios actually executed live
  against the harness board, retrieved the resulting task through the board API,
  and `rubric_check.passed == true` — an HTTP failure is never a demonstration);
- `distinct_task_ids` has at least 2 entries (>= 2 live tasks demonstrated);
- every executed scenario has `rubric_check.passed == true` (observed board
  status equals the operator rubric's expected status AND every
  `expected_signals` entry from the operator rubric verifies against the board
  evidence — task status, run list, activity, comments, and audit log);
- every executed scenario has a non-empty `evidence` block with
  `task_http_status == 200` (the runner actually read the task back);
- live proof on the board side: for at least two of the executed scenarios, the
  harness board's own audit shows the run (issue created, agent run, comment) —
  cross-check in the board UI or via the API with the same scoped key, and note
  the issue ids in the completion comment.

The runner exits non-zero when any scenario failed, when
`demonstration_count < 2`, or when `distinct_task_ids` has fewer than 2 entries;
treat a zero exit as necessary but not sufficient — the checklist above still
applies.

Attach `report.json` to the harness issue (and link it from its parent) with the completion
comment: datastore profile used, pinned image digest, the two negative probe
outputs, the rubric permission outputs, and the live issue ids. Redact nothing
except secrets (there should be none in the report — `run.py` never writes the
token).

Report field dictionary (all produced by `run.py`):

| Field | Source |
|---|---|
| `board`, `board_url`, `company_id`, `dry_run`, `rubric_loaded` | run.py arguments/env (`board_url` is the harness URL only) |
| `profile` | `--profile` value |
| `scenarios[].id`, `.title` | `harness-lab/manifest.json` |
| `scenarios[].task_id` | id of the board task created/read for this scenario |
| `scenarios[].http_status`, `.response` | board API responses during the run |
| `scenarios[].evidence.task_http_status` | GET `/api/issues/{task_id}` — must be 200 |
| `scenarios[].evidence.runs`, `.run_count` | GET `/api/issues/{task_id}/runs` |
| `scenarios[].evidence.activity_count`, `.comments_count` | GET `/api/issues/{task_id}/activity`, `/comments` |
| `scenarios[].evidence.audit_count`, `.audit_http_status` | GET `/api/companies/{id}/audit/agent-actions` |
| `scenarios[].rubric_check.expected_status` | operator rubric per scenario |
| `scenarios[].rubric_check.observed_status` | task status read back after the run |
| `scenarios[].rubric_check.status_matches` | `observed_status == expected_status` |
| `scenarios[].rubric_check.expected_signals` | operator rubric `expected_signals` per scenario |
| `scenarios[].rubric_check.signal_results` | per-signal `{expected, observed, passed}` derived from evidence |
| `scenarios[].rubric_check.passed` | `status_matches AND all signal_results passed` |
| `scenario_count` | number of manifest scenarios (5) |
| `executed_count` | scenarios that actually ran against the board (excludes not-run) |
| `demonstration_count` | scenarios that ran AND passed rubric_check (must be >= 2) |
| `failed_count` | scenarios whose HTTP call or rubric check failed |
| `distinct_task_ids` | distinct board task ids among demonstrations (must be >= 2) |

## 9. Verification checklist (map to the harness acceptance items)

| Acceptance item | Proof to attach |
|---|---|
| 1. Isolated board endpoint/datastore | Step 4 outputs (a)(b)(c) + compose project/volume names; negative probe 1 |
| 2. Scoped credentials | Step 5 curl outputs (works on harness company, 401/403 elsewhere) |
| 3. Approved profile/runner command | Step 7 command line + the `run.py` summary line from step 8 |
| 4. Operator-only rubric | Step 6 chmod listing + negative probe 2 outputs (executor denied, runner reads) |
| 5. Report >= 5 scenarios, >= 2 live tasks | Step 8 `report.json` (counts + `rubric_check`) + board-side issue ids |

## 10. Rollback

Stop the isolated stack and remove its datastore. This touches nothing outside
the `harness-lab` compose project:

```sh
cd /srv/harness-lab
docker compose --project-name harness-lab --env-file harness.env \
  -f docker-compose.harness-lab.yml down -v    # -v removes harness_pgdata + harness-board-data
# Profile A (shared PG) additionally:
#   psql -h 127.0.0.1 -U postgres -c 'DROP DATABASE IF EXISTS harness_lab; DROP ROLE IF EXISTS harness_lab;'
rm -f /srv/harness-lab/harness.env /srv/harness-lab/harness-runner.env
rm -rf /srv/harness-lab/private
# Rotate/revoke the agent API key if the board is still running elsewhere; if the
# whole instance is gone, the key died with its datastore.
```

## 11. After the live run

- Rotate the board-scoped token (step 5) — create a new agent API key, update the
  0600 env file, revoke the old key on the board.
- Keep the rubric on the operator-only path for re-runs; do not copy it into any
  executor-visible checkout or task.
- Production Paperclip remains forbidden as a harness target; the harness URL is
  always the 3200 instance from this runbook.
