# Manual CI timeout smoke

This runbook is for maintainers of the Myrmidon repository's self-hosted GitHub Actions runners. It checks a real job timeout and subsequent runner cleanup without changing production jobs. The manual workflow `.github/workflows/myrmidon-ci-timeout-smoke.yml` has one `self-hosted` job, `timeout-minutes: 1`, `sleep 99999`, and `permissions: {}`. Merging the workflow does not prove the smoke or cleanup passed.

## Before dispatch

1. Coordinate one execution and a read-only host precheck and postcheck with the runner infrastructure owner. Use an agreed CI slot. Confirm with the owner, using authorized access, that an eligible runner is idle; do not interrupt or occupy a busy runner. The workflow uses the generic `self-hosted` label, so an idle check alone does not pin a particular host.
2. Check existing runs of this workflow and the coordination record. If the authorized smoke already exists, inspect that run instead of starting another. If runner state or host access cannot be established, stop and coordinate; do not guess or try alternate credentials.
3. Record the workflow path, ref, actual workflow commit SHA, precheck time, and intended slot. Obtain the owner's agreement to exactly one dispatch. Do not dispatch for documentation or repeat a run merely to collect evidence.

## Execute and collect evidence

1. The designated operator dispatches the workflow once on the agreed ref and immediately records its run URL. Do not change runner labels, routing, or production job timeouts for this smoke.
2. Inspect the run's jobs through the GitHub Actions jobs API. Record the job ID and name, `conclusion`, `started_at`, `completed_at`, and `runner_id` and `runner_name`, together with the run URL and actual head SHA. The acceptance condition is the job conclusion `timed_out`: a run-level `failure`, a step timeout, or `cancelled` alone is not proof of a job timeout.
3. Map the reported runner identity to its actual host with the infrastructure owner. On that host, perform a read-only postcheck for the specific smoke job and record the check time and evidence that its `sleep 99999` and associated `Runner.Worker` have exited. Do not treat processes belonging to other jobs as smoke processes or terminate them. A timeout result without this host evidence does not prove cleanup.
4. Record both the timeout and cleanup outcomes in the coordination record. If the job ran on an unexpected or inaccessible host, or evidence is incomplete, report the result as unverified and involve the infrastructure owner; do not dispatch again.

To inspect an existing run without starting one, use `gh api repos/itkadr-git/myrmidon/actions/runs/RUN_ID/jobs` and substitute the recorded run ID. The workflow runs API can identify existing runs: `gh api repos/itkadr-git/myrmidon/actions/workflows/myrmidon-ci-timeout-smoke.yml/runs`.
