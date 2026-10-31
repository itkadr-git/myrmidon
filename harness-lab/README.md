# HARNESS-LAB reference harness

This harness is intentionally scoped to the isolated `myr-dev-build` board. It refuses to run when `HARNESS_LAB_BOARD_URL` is unset, when the URL is the production Paperclip URL, or when the operator-only rubric is unavailable.

## One-command run

```sh
HARNESS_LAB_BOARD_URL=https://myr-dev-build.example/api \
HARNESS_LAB_RUBRIC_PATH=/srv/harness-lab/private/acceptance.json \
python3 harness-lab/run.py --profile hermes-gateway --report harness-lab/report.json
```

The board URL and rubric path are operator-provided and must not be put in an executor task description. The rubric is read only by the runner for post-run validation; it is not part of this checkout and must be readable only by the operator/runner identity.

The manifest contains five scenarios: review-gate bypass, unjustified blocked, CI wait without monitor, idle run, and a normal control. The runner creates/locates the scenarios, invokes the configured profile through the isolated board API, reads back statuses and run metadata, and writes a JSON report. It never targets the production URL.

This checkout does not contain production credentials or an operator-only rubric. A real demonstration requires the myr-dev-build board endpoint, restricted credentials, and the profile command supplied by the board operator.
