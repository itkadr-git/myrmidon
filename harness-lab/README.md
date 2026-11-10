# HARNESS-LAB reference harness

This harness is intentionally scoped to the isolated `myr-dev-build` board. It refuses to run when `HARNESS_LAB_BOARD_URL` is unset, when the URL is the production Paperclip URL, or when the operator-only rubric is unavailable.

## One-command run

```sh
HARNESS_LAB_BOARD_URL=https://myr-dev-build.example/api \
HARNESS_LAB_RUBRIC_PATH=/srv/harness-lab/private/acceptance.json \
python3 harness-lab/run.py --profile hermes-gateway --report harness-lab/report.json
```

The board URL and rubric path are operator-provided and must not be put in an executor task description. The rubric is read only by the runner for post-run validation; it is not part of this checkout and must be readable only by the operator/runner identity.

The runner verifies each scenario against board evidence: it creates (or finds) the board task for the scenario, reads the task back via `GET /api/issues/{id}`, and pulls the run list (`/runs`), activity log (`/activity`), comments (`/comments`), and the company agent-action audit (`/audit/agent-actions`) as evidence. The operator-only rubric supplies both the expected final status and per-signal behavioral expectations (`expected_signals`), each of which the runner derives from that evidence (e.g. review stage requested, blocker/owner recorded, monitor with next check time, durable mutation count, artifact + verification markers). A scenario counts as a demonstration only when its HTTP call succeeded, the task was actually read back (evidence block present), and every rubric signal verified; the runner exits non-zero when any scenario failed or fewer than 2 distinct live tasks were demonstrated.

The runner verifies each scenario against real board evidence — task read-back, run list, activity, comments, and agent-action audit — rather than trusting POST responses; see the verification paragraph below and `ops/PROVISIONING-RUNBOOK.md` §8.

This checkout does not contain production credentials or an operator-only rubric. A real demonstration requires the myr-dev-build board endpoint, restricted credentials, and the profile command supplied by the board operator.

## Operator provisioning

The board endpoint, scoped credentials, and the operator-only rubric are provisioned by the board operator, not by agents. The mechanical steps live in `ops/PROVISIONING-RUNBOOK.md`, and the rubric template (to be deployed to the operator-only path) is `ops/acceptance-rubric.template.json`.
