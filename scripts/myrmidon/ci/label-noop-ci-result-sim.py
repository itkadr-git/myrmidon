#!/usr/bin/env python3
"""scripts/myrmidon/ci/label-noop-ci-result-sim.py

OPE-12841 / CI-LABEL-NOOP-KEEPS-RESULT behavioural check of the label
handling of myrmidon-ci.yml.

History. OPE-12841: a `labeled` run for a label other than `full-ci` skipped
every job, and the skipped `CI result` check counted as passed (PR #2965
merged on a cancelled head). The first fix renamed the job in noop runs; the
noop run then became the NEWEST run of the workflow on the head, the required
`CI result` was read as "expected" and green PRs (#3147, #3088, #3095) could
not be merged. Now the main workflow has no `labeled` trigger at all: a label
creates no run of it, the verdict of the last real run stays, and the
OPE-12841 protection holds by construction. `full-ci` is handled by
myrmidon-ci-full-label.yml, which re-runs the real run.

The script reads the workflow YAML and executes the trigger match plus the
ruleset reading of the required check:
  - an event creates a run of a workflow only if its `on:` lists the event
    and action (pull_request: types);
  - a run publishes `CI result` (static job name, `!cancelled()` gate) with its
    real verdict; the ruleset reads the newest `CI result` of the head
    (`success`/`skipped` satisfy, others block), no check = pending.
Teeth: with `labeled` put back into the types of the main workflow, the
simulator must show a noop run that is the newest run without a `CI result`
(the defect), i.e. report the head as `expected`.

Exit code 0 only when every scenario and the teeth check pass.
"""

import copy
import sys

import yaml

MAIN = ".github/workflows/myrmidon-ci.yml"
FULL_LABEL = ".github/workflows/myrmidon-ci-full-label.yml"
REQUIRED_NAME = "CI result"


def on_block(doc):
    # PyYAML reads the key `on` as boolean True.
    return doc.get(True) or doc.get("on") or {}


def creates_run(doc, event, action):
    """Does this event start a run of the workflow (trigger match only)?"""
    block = on_block(doc)
    if isinstance(block, str):
        block = {block: None}
    if isinstance(block, list):
        block = {name: None for name in block}
    if event not in block:
        return False
    cfg = block[event]
    if event == "pull_request":
        types = (cfg or {}).get("types") or ["opened", "synchronize", "reopened"]
        return action in types
    return True


def full_label_job_runs(doc, label):
    """Does the full-label workflow's job run for this label?"""
    job = next(iter((doc.get("jobs") or {}).values()))
    gate = str(job.get("if", "")).strip()
    if gate.startswith("${{") and gate.endswith("}}"):
        gate = gate[3:-2].strip()
    if gate == "github.event.label.name == 'full-ci'":
        return label == "full-ci"
    raise SystemExit(f"FAIL: unrecognised gate in the full-label job: {gate!r}")


def head_state(main_doc, events, real_run):
    """Required-check state on the head after `events` (list of (event, action, label)).

    `real_run`: conclusion of the newest real run's `CI result`
    (None = still running, 'success', 'cancelled', 'failure').
    A run created by a label event is a noop run: no job has a name
    `CI result` and the newest run of the workflow is that one.
    """
    state = real_run
    newest_is_noop = False
    for event, action, _label in events:
        if creates_run(main_doc, event, action):
            newest_is_noop = True
    if newest_is_noop:
        return "expected"
    if state is None:
        return "pending"
    return "satisfied" if state in ("success", "skipped") else "blocked"


# (label, real_run_conclusion, expected state of the required check)
LABEL_SCENARIOS = [
    # The #3147 case: green real run, board labels the PR review-approved.
    ("review-approved", "success", "satisfied"),
    ("needs-rebase", "success", "satisfied"),
    ("review-in-progress", "success", "satisfied"),
    # OPE-12841 / PR #2965: the real run was cancelled, a label arrives: the
    # label must not make the check pass.
    ("review-approved", "cancelled", "blocked"),
    ("review-approved", None, "pending"),
    ("review-approved", "failure", "blocked"),
]


def run_scenarios(main_doc, full_doc):
    failures = []
    for index, (label, real, expected) in enumerate(LABEL_SCENARIOS):
        state = head_state(main_doc, [("pull_request", "labeled", label)], real)
        ok = state == expected
        print(
            f"[{'ok' if ok else 'FAIL'}] scenario {index}: "
            f"pull_request/labeled/{label} real_run={real or 'in-progress'} "
            f"ruleset={state} expected={expected}"
        )
        if not ok:
            failures.append(index)
    # full-ci: no run of the main workflow from the event itself, the
    # full-label workflow's job runs for it only.
    index = len(LABEL_SCENARIOS)
    ok = (
        not creates_run(main_doc, "pull_request", "labeled")
        and creates_run(full_doc, "pull_request", "labeled")
        and full_label_job_runs(full_doc, "full-ci")
        and not full_label_job_runs(full_doc, "review-approved")
        and not full_label_job_runs(full_doc, "needs-rebase")
    )
    print(
        f"[{'ok' if ok else 'FAIL'}] scenario {index}: full-ci handled only by the "
        f"full-label workflow, its job skips every other label"
    )
    if not ok:
        failures.append(index)
    # The full-label workflow must not be able to publish the required check.
    names = [str(job.get("name", "")) for job in (full_doc.get("jobs") or {}).values()]
    ok = REQUIRED_NAME not in names and full_doc.get("name") != main_doc.get("name")
    print(f"[{'ok' if ok else 'FAIL'}] scenario {index + 1}: full-label workflow has another name and no `{REQUIRED_NAME}` job")
    if not ok:
        failures.append(index + 1)
    return failures


def run_teeth(main_doc, full_doc):
    """With `labeled` back in the main workflow the defect must reproduce."""
    mutated = copy.deepcopy(main_doc)
    block = on_block(mutated)
    block["pull_request"]["types"] = list(block["pull_request"]["types"]) + ["labeled"]
    state = head_state(mutated, [("pull_request", "labeled", "review-approved")], "success")
    ok = state == "expected"
    print(
        f"[{'ok' if ok else 'FAIL'}] teeth: `labeled` back in the trigger types -> a green head "
        f"becomes '{state}'; the defect must reproduce as 'expected'"
    )
    return 0 if ok else 1


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return yaml.safe_load(handle)
    except OSError as exc:
        print(f"FAIL: cannot read workflow {path}: {exc}", file=sys.stderr)
        raise SystemExit(2)


def parse_args(argv):
    args = list(argv)
    main, full = MAIN, FULL_LABEL
    if "--workflow" in args:
        i = args.index("--workflow")
        main = args[i + 1]
        del args[i : i + 2]
    if "--full-label-workflow" in args:
        i = args.index("--full-label-workflow")
        full = args[i + 1]
        del args[i : i + 2]
    if args:
        print(f"unknown arguments: {args}", file=sys.stderr)
        raise SystemExit(2)
    return main, full


def main(argv=None):
    main_path, full_path = parse_args(sys.argv[1:] if argv is None else argv)
    main_doc, full_doc = load(main_path), load(full_path)
    jobs = main_doc.get("jobs") or {}
    ci = jobs.get("ci-result")
    if ci is None or str(ci.get("name", "")).strip() != REQUIRED_NAME:
        print("FAIL: ci-result must keep the static name `CI result`", file=sys.stderr)
        return 2
    failures = run_scenarios(main_doc, full_doc)
    if run_teeth(main_doc, full_doc) != 0:
        failures.append(-1)
    if failures:
        print(f"FAILED: {failures}", file=sys.stderr)
        return 1
    print("all scenarios pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
