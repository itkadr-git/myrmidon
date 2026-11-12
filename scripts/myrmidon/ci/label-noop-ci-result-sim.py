#!/usr/bin/env python3
"""scripts/myrmidon/ci/label-noop-ci-result-sim.py

OPE-12841 behavioural execution engine for myrmidon-ci.yml.

Instead of asserting on workflow source strings, this script EXECUTES the
job graph of `.github/workflows/myrmidon-ci.yml`: it parses the workflow
YAML, reads each job's real `if:`/`name:` expressions, translates the
GitHub Actions expression language to Python, and evaluates it against
concrete event contexts (a `labeled` run with `review-approved`, a real
push/merge-queue run, a red plan). Job conclusions follow GitHub's needs
semantics (a skipped gate -> skipped; a failed/cancelled need fails the
summary unless the gate keeps it running). The checks each event would
publish on the PR head are collected, and a branch-ruleset reader keeps
only checks named `CI result` — the required check the merge gate reads.
The merge gate is satisfied only when the latest completed `CI result`
on the head is `success`; `skipped`/`cancelled`/`failure` and a missing
check keep the PR blocked.

The script also proves its own teeth: it re-runs the PR #2965 scenario
against a mutated workflow whose ci-result job carries the static
required name (the pre-fix shape) and requires the simulator to show the
PR being waved through in that case.

Exit code 0 only when every required scenario and the teeth check pass.
Used by label-noop-ci-result.test.mjs (node --test, same pattern as
workflow-concurrency.test.mjs -> check-workflow-concurrency.py).
"""

import copy
import re
import sys

import yaml

WORKFLOW = ".github/workflows/myrmidon-ci.yml"
REQUIRED_NAME = "CI result"


class ExprError(Exception):
    pass


def translate(expr):
    """Translate a GitHub Actions expression to Python source."""
    expr = expr.strip()
    expr = re.sub(r"!\s*(?=[A-Za-z(])", " not ", expr)  # `!` but not `!=`
    expr = re.sub(r"&&", " and ", expr)
    expr = re.sub(r"\|\|", " or ", expr)
    expr = re.sub(r"\bcancelled\(\s*\)", " cancelled_var ", expr)
    expr = re.sub(r"\bgithub\.event\.label\.name\b", " label ", expr)
    expr = re.sub(r"\bgithub\.event\.action\b", " action ", expr)
    expr = re.sub(r"\bgithub\.event_name\b", " event_name ", expr)
    expr = re.sub(
        r"\bgithub\.event\.pull_request\.labels\*\.name\b", " labels ", expr
    )
    expr = re.sub(r"\bneeds\.plan\.outputs\.tier\b", " tier ", expr)
    expr = re.sub(r"\bneeds\.plan\.result\b", " plan_result ", expr)
    # contains(<identifier>, 'literal') -> substring test.
    expr = re.sub(
        r"contains\(\s*([A-Za-z_][A-Za-z0-9_]*),\s*'([^']*)'\s*\)",
        r" ('\2' in \1) ",
        expr,
    )
    return expr


def evaluate(expr, ctx):
    """Evaluate a stripped GitHub Actions expression against a context."""
    source = translate(expr)
    env = dict(ctx)
    env["__builtins__"] = {}
    try:
        return eval(source, env)  # noqa: S307 - expressions from our own workflow
    except Exception as exc:
        raise ExprError(f"cannot evaluate {expr!r} as {source!r}: {exc}") from exc


def strip_template(value):
    value = str(value).strip()
    if value.startswith("${{") and value.endswith("}}"):
        return value[3:-2].strip()
    return value


def job_conclusion(needs_results):
    """GitHub needs semantics once a job's gate let it run."""
    if any(result == "cancelled" for result in needs_results.values()):
        return "cancelled"
    if any(result == "failure" for result in needs_results.values()):
        return "failure"
    return "success"


def execute_workflow(jobs, ctx):
    """Execute the job graph; return {job: conclusion} in scheduling order."""
    runs = {}
    for name, job in jobs.items():
        if name == "report-main":
            continue  # main-branch reporting, never part of a PR head check set
        needs = job.get("needs") or []
        needs_results = {dep: runs.get(dep, "skipped") for dep in needs}
        local = dict(ctx)
        local["cancelled_var"] = any(
            result == "cancelled" for result in needs_results.values()
        )
        gate = job.get("if")
        if gate is not None and not evaluate(strip_template(gate), local):
            runs[name] = "skipped"
            continue
        if name == "plan":
            # The tier-selection script's own exit code stands in for the
            # plan logic (outside this workflow's scope); the gate above
            # already skipped the job on label-noop events.
            runs[name] = ctx["plan_conclusion"]
        else:
            runs[name] = job_conclusion(needs_results)
    return runs


def published_checks(jobs, ctx, runs):
    """The check runs this event publishes on the head, in job order."""
    checks = []
    for name, job in jobs.items():
        if name in ("ci-result", "report-main"):
            continue
        if runs.get(name) != "skipped":
            # Lane checks have non-required names; their exact names do not
            # matter to the ruleset, only that they are not `CI result`.
            checks.append((f"job:{name}", runs[name]))
    ci = jobs["ci-result"]
    local = dict(ctx)
    needs_results = {
        dep: runs.get(dep, "skipped") for dep in (ci.get("needs") or [])
    }
    local["cancelled_var"] = any(
        result == "cancelled" for result in needs_results.values()
    )
    gate = ci.get("if")
    if gate is not None and not evaluate(strip_template(gate), local):
        conclusion = "skipped"
    else:
        conclusion = job_conclusion(needs_results)
    raw_name = str(ci.get("name", REQUIRED_NAME)).strip()
    if raw_name.startswith("${{") and raw_name.endswith("}}"):
        check_name = str(evaluate(strip_template(raw_name), ctx))
    else:
        check_name = raw_name
    checks.append((check_name, conclusion))
    return checks


def ruleset_gate(checks, head_run_conclusion):
    """Execute GitHub branch-ruleset semantics for the required check.

    `head_run_conclusion`: conclusion of the real push-run `CI result`
    check already on this head (None = that run has not completed yet).
    GitHub's branch ruleset treats BOTH `success` and `skipped` of the
    required check (`CI result`) as satisfied (which is why a skipped
    `CI result` waved PR #2965 through auto-merge). A check under any
    other name is ignored by the ruleset, leaving the existing real check
    on the head as the verdict. `cancelled`, `failure` or missing keep
    the PR blocked.
    """
    published_required = [c for c in checks if c[0] == REQUIRED_NAME]
    if published_required:
        # The newest completed check with the required name overwrites the
        # head's required check; GitHub treats `success` and `skipped` as
        # satisfying the required status check.
        latest = published_required[-1][1]
        return "satisfied" if latest in ("success", "skipped") else "blocked"
    if head_run_conclusion is None:
        return "pending"
    return "satisfied" if head_run_conclusion == "success" else "blocked"


# (event_name, action, label, tier, plan_conclusion, head_run_conclusion,
#  expected_ruleset_gate)
SCENARIOS = [
    # PR #2965 replay: the push run was cancelled, then `review-approved`
    # was labelled. The noop run must not hand the merge gate a pass.
    (
        "pull_request", "labeled", "review-approved", None, "success",
        "cancelled", "blocked",
    ),
    # Same labeled event while the real run is still in progress: the
    # required check does not exist as completed, merge stays blocked.
    (
        "pull_request", "labeled", "review-approved", None, "success",
        None, "pending",
    ),
    # A cancelled full run must not be overridden to a pass either: the
    # noop run publishes no required check, cancelled keeps blocking.
    (
        "pull_request", "labeled", "review-approved", None, "success",
        "skipped", "blocked",
    ),
    # A real run whose plan went red fails the summary -> blocked, never a
    # satisfying skipped check (the rejected needs.plan.result re-gate).
    (
        "push", None, None, "full", "failure", "cancelled", "blocked",
    ),
    # A green merge-queue candidate satisfies the gate (regression guard:
    # the fix must not break real runs).
    (
        "merge_group", None, None, "full", "success", "cancelled", "satisfied",
    ),
    # A `full-ci` labeled run is a real run and republishes `CI result`.
    (
        "pull_request", "labeled", "full-ci", "full", "success", "cancelled",
        "satisfied",
    ),
]


def run_scenarios(jobs):
    failures = []
    for index, (event_name, action, label, tier, plan_conclusion,
                head_run, expected) in enumerate(SCENARIOS):
        ctx = {
            "event_name": event_name,
            "action": action,
            "label": label,
            "labels": [label] if label else [],
            "tier": tier,
            "plan_result": plan_conclusion,
            "plan_conclusion": plan_conclusion,
        }
        runs = execute_workflow(jobs, ctx)
        checks = published_checks(jobs, ctx, runs)
        gate = ruleset_gate(checks, head_run)
        required_names = [name for name, _ in checks if name == REQUIRED_NAME]
        ok = gate == expected
        if event_name == "pull_request" and action == "labeled" and label != "full-ci":
            ok = ok and not required_names
        print(
            f"[{'ok' if ok else 'FAIL'}] scenario {index}: "
            f"{event_name}/{action or '-'}/{label or '-'} tier={tier} "
            f"plan={plan_conclusion} head_run={head_run or 'in-progress'} "
            f"published={checks} ruleset={gate} expected={expected}"
            + ("" if not required_names else f" required-name-published={required_names}")
        )
        if not ok:
            failures.append(index)
    return failures


def run_teeth(jobs):
    """Prove the simulator detects the original defect.

    Mutate ci-result back to the pre-fix shape (static required name) and
    require the PR #2965 replay to come out SATISFIED — i.e. the merge
    would be waved through without tests. If the mutated workflow does not
    satisfy the gate, the simulator lost its teeth.
    """
    mutated = copy.deepcopy(jobs)
    mutated["ci-result"]["name"] = REQUIRED_NAME
    ctx = {
        "event_name": "pull_request",
        "action": "labeled",
        "label": "review-approved",
        "labels": ["review-approved"],
        "tier": None,
        "plan_result": "success",
        "plan_conclusion": "success",
    }
    runs = execute_workflow(mutated, ctx)
    checks = published_checks(mutated, ctx, runs)
    gate = ruleset_gate(checks, "cancelled")
    names = [name for name, _ in checks if name == REQUIRED_NAME]
    ok = gate == "satisfied" and names == [REQUIRED_NAME]
    print(
        f"[{'ok' if ok else 'FAIL'}] teeth: pre-fix shape (static '{REQUIRED_NAME}' "
        f"name) on the review-approved noop run publishes {checks} "
        f"-> ruleset {gate}; the defect must reproduce as 'satisfied'"
    )
    return 0 if ok else 1


def parse_args(argv):
    args = list(argv)
    workflow = WORKFLOW
    if "--workflow" in args:
        index = args.index("--workflow")
        workflow = args[index + 1]
        del args[index : index + 2]
    if args:
        print(f"unknown arguments: {args}", file=sys.stderr)
        raise SystemExit(2)
    return workflow


def main(argv=None):
    workflow = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        with open(workflow, encoding="utf-8") as handle:
            doc = yaml.safe_load(handle)
    except OSError as exc:
        print(f"FAIL: cannot read workflow {workflow}: {exc}", file=sys.stderr)
        return 2
    jobs = doc.get("jobs") or {}
    if "ci-result" not in jobs:
        print("FAIL: no ci-result job in the workflow", file=sys.stderr)
        return 2
    failures = run_scenarios(jobs)
    teeth_exit = run_teeth(jobs)
    if teeth_exit != 0:
        failures.append(len(SCENARIOS))
    if failures:
        print(f"FAILED: {failures}", file=sys.stderr)
        return 1
    print("all scenarios pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
