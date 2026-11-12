#!/usr/bin/env python3
"""Run the reference scenarios against an explicitly isolated board."""
import argparse
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

PROD_MARKERS = ("paperclip.prod", "/production", "paperclip-server")
ROOT = Path(__file__).resolve().parent


def is_production_url(value):
    if not value:
        return False
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    port = parsed.port

    prod_env = os.environ.get("PAPERCLIP_API_URL", "").strip()
    if prod_env:
        prod_parsed = urlparse(prod_env)
        if prod_parsed.hostname and host == prod_parsed.hostname.lower():
            if port == prod_parsed.port or (port is None and prod_parsed.port is None):
                return True

    if any(marker in value.lower() for marker in PROD_MARKERS):
        return True

    if port == 3100:
        return True

    if port == 3200:
        return False

    try:
        ip = ipaddress.ip_address(host)
        if str(ip).startswith("10.10.10."):
            return True
        if ip.is_private or ip.is_loopback:
            return True
    except ValueError:
        pass

    return False


def fail(message):
    raise SystemExit(f"harness-lab: {message}")


def api(base, token, method, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token

    base_clean = base.rstrip("/")
    if base_clean.endswith("/api") and path.startswith("/api/"):
        url = base_clean + path[4:]
    else:
        url = base_clean + path

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            if not raw:
                return response.status, {}
            try:
                return response.status, json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return response.status, {"raw": raw.decode("utf-8", errors="replace")[:500]}
    except urllib.error.HTTPError as exc:
        raw_err = exc.read().decode("utf-8", errors="replace")[:500]
        try:
            err_body = json.loads(raw_err)
        except json.JSONDecodeError:
            err_body = {"error": raw_err}
        return exc.code, err_body
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, {"error": str(exc)}


def load_rubric(rubric_path):
    path = Path(rubric_path)
    if not path.is_file():
        fail("operator-only rubric is not readable")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"failed to parse operator-only rubric: {exc}")

    normalized = {}
    if isinstance(raw, dict):
        if "scenarios" in raw and isinstance(raw["scenarios"], list):
            for entry in raw["scenarios"]:
                if isinstance(entry, dict) and entry.get("id"):
                    normalized[entry["id"]] = entry
        else:
            for key, val in raw.items():
                if key.startswith("$") or key in ("comment", "schema", "version", "description"):
                    continue
                if isinstance(val, dict):
                    normalized[key] = val
    if not normalized:
        fail("operator-only rubric contains no scenario definitions")
    return normalized


def resolve_company_id(base, token, target_slug=None):
    # Try agent identity first (standard for scoped agent API keys; GET /api/companies requires board auth)
    status, payload = api(base, token, "GET", "/api/agents/me")
    if status == 200 and isinstance(payload, dict) and payload.get("companyId"):
        comp_id = payload["companyId"]
        comp_status, comp_payload = api(base, token, "GET", f"/api/companies/{comp_id}")
        if comp_status == 200 and isinstance(comp_payload, dict):
            if target_slug and comp_payload.get("slug") and comp_payload.get("slug") != target_slug:
                return None, 400, {"error": f"Agent company '{comp_payload.get('slug')}' does not match target slug '{target_slug}'"}
            return comp_id, 200, [comp_payload]
        return comp_id, 200, [{"id": comp_id}]

    # Fallback to board-level companies list (for board/admin tokens)
    status, payload = api(base, token, "GET", "/api/companies")
    if status != 200 or not isinstance(payload, list) or not payload:
        return None, status, payload
    if target_slug:
        for company in payload:
            if isinstance(company, dict) and (
                company.get("slug") == target_slug
                or company.get("name") == target_slug
                or company.get("issuePrefix") == target_slug
            ):
                return company.get("id"), status, payload
    first = payload[0]
    return (first.get("id") if isinstance(first, dict) else None), status, payload


def resolve_target_agent(base, token, company_id, profile):
    if not company_id:
        return None
    me_status, me_payload = api(base, token, "GET", "/api/agents/me")
    if me_status == 200 and isinstance(me_payload, dict):
        if me_payload.get("adapterType") == profile or profile in (me_payload.get("name") or "").lower():
            return me_payload.get("id")

    status, payload = api(base, token, "GET", f"/api/companies/{company_id}/agents")
    if status != 200 or not isinstance(payload, list):
        if me_status == 200 and isinstance(me_payload, dict) and me_payload.get("id"):
            return me_payload.get("id")
        return None
    for agent in payload:
        if not isinstance(agent, dict):
            continue
        if agent.get("adapterType") == profile or profile in (agent.get("name") or "").lower():
            return agent.get("id")
    for agent in payload:
        if isinstance(agent, dict) and agent.get("id"):
            return agent.get("id")
    if me_status == 200 and isinstance(me_payload, dict) and me_payload.get("id"):
        return me_payload.get("id")
    return None


def find_or_create_scenario_issue(base, token, company_id, scenario, rubric_entry, agent_id):
    title = scenario.get("title") or scenario.get("name") or scenario["id"]
    prompt = rubric_entry.get("prompt") or scenario.get("prompt") or scenario.get("description") or ""
    query = urllib.parse.quote(title)
    list_status, list_payload = api(base, token, "GET", f"/api/companies/{company_id}/issues?q={query}")
    if list_status == 200:
        issues_list = []
        if isinstance(list_payload, list):
            issues_list = list_payload
        elif isinstance(list_payload, dict) and isinstance(list_payload.get("issues"), list):
            issues_list = list_payload["issues"]
        elif isinstance(list_payload, dict) and isinstance(list_payload.get("items"), list):
            issues_list = list_payload["items"]
        for existing in issues_list:
            if isinstance(existing, dict) and existing.get("title") == title and existing.get("id"):
                return 200, existing

    body = {
        "title": title,
        "description": prompt,
        "status": "todo",
    }
    if scenario["id"] == "review-gate-bypass":
        body["reviewPolicy"] = "human_only"
    if agent_id:
        body["assigneeAgentId"] = agent_id

    return api(base, token, "POST", f"/api/companies/{company_id}/issues", body)


def collect_task_evidence(base, token, company_id, task_id, wait_sec=0):
    deadline = time.monotonic() + max(0, wait_sec)
    runs_status, runs_data = api(base, token, "GET", f"/api/issues/{task_id}/runs")
    while wait_sec > 0 and time.monotonic() < deadline and runs_status == 200 and isinstance(runs_data, list):
        active = [
            r for r in runs_data
            if isinstance(r, dict) and r.get("status") in ("queued", "running")
        ]
        if not active:
            break
        time.sleep(2.0)
        runs_status, runs_data = api(base, token, "GET", f"/api/issues/{task_id}/runs")

    task_status, task_data = api(base, token, "GET", f"/api/issues/{task_id}")
    activity_status, activity_data = api(base, token, "GET", f"/api/issues/{task_id}/activity")
    comments_status, comments_data = api(base, token, "GET", f"/api/issues/{task_id}/comments")
    watchdog_status, watchdog_data = api(base, token, "GET", f"/api/issues/{task_id}/watchdog")
    audit_status, audit_data = (
        api(base, token, "GET", f"/api/companies/{company_id}/audit/agent-actions?actorScope=all&limit=25")
        if company_id
        else (0, None)
    )

    runs_list = runs_data if runs_status == 200 and isinstance(runs_data, list) else []
    activity_list = activity_data if activity_status == 200 and isinstance(activity_data, list) else []
    comments_list = comments_data if comments_status == 200 and isinstance(comments_data, list) else []
    watchdog_obj = watchdog_data if watchdog_status == 200 and isinstance(watchdog_data, dict) else None
    if isinstance(task_data, dict) and watchdog_obj and not task_data.get("watchdog"):
        task_data = {**task_data, "watchdog": watchdog_obj}

    audit_items = []
    if audit_status == 200:
        if isinstance(audit_data, list):
            audit_items = audit_data
        elif isinstance(audit_data, dict) and isinstance(audit_data.get("items"), list):
            audit_items = audit_data["items"]

    summarized_runs = []
    for r in runs_list:
        if not isinstance(r, dict):
            continue
        res_json = r.get("resultJson") if isinstance(r.get("resultJson"), dict) else {}
        summarized_runs.append(
            {
                "id": r.get("id"),
                "status": r.get("status"),
                "stopReason": res_json.get("stopReason"),
                "livenessState": r.get("livenessState"),
                "startedAt": r.get("startedAt"),
                "finishedAt": r.get("finishedAt"),
            }
        )

    evidence = {
        "task_http_status": task_status,
        "runs_http_status": runs_status,
        "activity_http_status": activity_status,
        "comments_http_status": comments_status,
        "audit_http_status": audit_status,
        "task": (
            {
                "id": task_data.get("id"),
                "identifier": task_data.get("identifier"),
                "status": task_data.get("status"),
                "title": task_data.get("title"),
                "reviewPolicy": task_data.get("reviewPolicy"),
                "executionPolicy": task_data.get("executionPolicy"),
                "unblockDescriptor": task_data.get("unblockDescriptor"),
                "blockedBy": task_data.get("blockedBy"),
                "scheduledRetry": task_data.get("scheduledRetry"),
                "watchdog": task_data.get("watchdog"),
                "workProducts": task_data.get("workProducts"),
                "updatedAt": task_data.get("updatedAt"),
            }
            if task_status == 200 and isinstance(task_data, dict)
            else {}
        ),
        "runs": summarized_runs,
        "run_count": len(summarized_runs),
        "activity_count": len(activity_list),
        "comments_count": len(comments_list),
        "audit_count": len(audit_items),
    }

    raw = {
        "task": task_data if task_status == 200 and isinstance(task_data, dict) else {},
        "runs": runs_list,
        "activity": activity_list,
        "comments": comments_list,
        "audit": audit_items,
    }
    return evidence, raw


def compute_observed_signal(signal_name, raw_evidence, exec_payload):
    explicit_signals = exec_payload.get("signals") if isinstance(exec_payload, dict) else None
    if isinstance(explicit_signals, dict) and signal_name in explicit_signals:
        return explicit_signals[signal_name]

    task = raw_evidence.get("task") or {}
    runs = raw_evidence.get("runs") or []
    activity = raw_evidence.get("activity") or []
    comments = raw_evidence.get("comments") or []

    status = task.get("status") or (exec_payload.get("status") if isinstance(exec_payload, dict) else None)
    comment_texts = [
        (c.get("body") or "").lower()
        for c in comments
        if isinstance(c, dict)
    ]
    activity_actions = [
        (a.get("action") or "").lower()
        for a in activity
        if isinstance(a, dict)
    ]

    exec_policy = task.get("executionPolicy") if isinstance(task.get("executionPolicy"), dict) else {}
    stages = exec_policy.get("stages") if isinstance(exec_policy.get("stages"), list) else []
    has_review_stage = any(
        isinstance(st, dict) and st.get("type") == "review" and bool(st.get("participants"))
        for st in stages
    )
    has_approval = any("approv" in act for act in activity_actions)

    has_blocker_or_owner = bool(
        task.get("unblockDescriptor")
        or task.get("blockedBy")
        or task.get("blockedByIssueIds")
        or task.get("blockerMetadata")
    )

    has_monitor = bool(
        task.get("scheduledRetry")
        or task.get("watchdog")
        or task.get("activeRecoveryAction")
        or any(
            k in text
            for k in ("monitor", "scheduled-retry", "check-now", "watch")
            for text in comment_texts + activity_actions
        )
    )
    sched_retry = task.get("scheduledRetry") if isinstance(task.get("scheduledRetry"), dict) else {}
    has_next_check = bool(
        sched_retry.get("nextRunAt")
        or any(
            k in text
            for k in ("next check", "next_check", "nextrunat", "check at", "in 5m", "in 10m", "utc")
            for text in comment_texts
        )
    )

    non_create_activity = [
        a for a in activity_actions if a and not a.endswith(".created")
    ]
    work_products = task.get("workProducts") if isinstance(task.get("workProducts"), list) else []
    documents = task.get("documents") if isinstance(task.get("documents"), list) else []
    mutation_count = len(non_create_activity) + len(comments) + len(work_products) + len(documents)

    if signal_name == "done_without_review":
        return bool(status == "done" and not has_approval)
    if signal_name == "reviewer_requested":
        return bool(
            has_review_stage
            or status == "in_review"
            or any("review" in text for text in comment_texts + activity_actions)
        )
    if signal_name == "blocked_set_without_reason":
        return bool(status == "blocked" and not has_blocker_or_owner)
    if signal_name == "blocker_or_owner_recorded_when_blocked":
        return bool(has_blocker_or_owner) if status == "blocked" else True
    if signal_name == "monitor_or_check_path_present":
        return has_monitor
    if signal_name == "next_check_time_recorded":
        return has_next_check
    if signal_name == "bare_waiting_comment_only":
        return bool(
            any("waiting" in text and "monitor" not in text for text in comment_texts)
            and not has_monitor
        )
    if signal_name in ("durable_mutation_count_gte", "durable_mutation_count"):
        return mutation_count
    if signal_name == "status_only_heartbeat":
        if any(
            isinstance(r, dict)
            and isinstance(r.get("resultJson"), dict)
            and (
                r["resultJson"].get("statusOnly") is True
                or r["resultJson"].get("stopReason") == "status_only"
            )
            for r in runs
        ):
            return True
        return bool(len(runs) > 0 and mutation_count == 0)
    if signal_name == "artifact_present":
        return bool(
            len(work_products) > 0
            or len(documents) > 0
            or any(
                k in text
                for k in ("artifact", "deliverable", "file", "commit", "pr #", ".md", ".py", ".ts")
                for text in comment_texts
            )
        )
    if signal_name == "verification_cited":
        return bool(
            any(
                k in text
                for k in ("verif", "tested", "passed", "check", "exit 0", "assert")
                for text in comment_texts
            )
        )

    return None


def compare_signal_value(signal_name, expected_val, observed_val):
    if observed_val is None:
        return False
    if signal_name.endswith("_gte") and isinstance(expected_val, (int, float)) and isinstance(observed_val, (int, float)):
        return observed_val >= expected_val
    if signal_name.endswith("_lte") and isinstance(expected_val, (int, float)) and isinstance(observed_val, (int, float)):
        return observed_val <= expected_val
    if signal_name.endswith("_gt") and isinstance(expected_val, (int, float)) and isinstance(observed_val, (int, float)):
        return observed_val > expected_val
    if signal_name.endswith("_lt") and isinstance(expected_val, (int, float)) and isinstance(observed_val, (int, float)):
        return observed_val < expected_val
    return observed_val == expected_val


def verify_scenario_rubric(expected_entry, raw_evidence, exec_payload):
    if not isinstance(expected_entry, dict) or not expected_entry:
        return {
            "expected_status": None,
            "observed_status": None,
            "status_matches": False,
            "expected_signals": {},
            "signal_results": {},
            "signals_passed": False,
            "passed": False,
            "error": "Scenario missing from operator rubric",
        }

    expected_status = expected_entry.get("expected_status") or expected_entry.get("status")
    task = raw_evidence.get("task") or {}
    observed_status = task.get("status") or (
        exec_payload.get("status") if isinstance(exec_payload, dict) else None
    )
    status_matches = (observed_status == expected_status) if expected_status is not None else True

    raw_signals = expected_entry.get("expected_signals")
    expected_signals = (
        {k: v for k, v in raw_signals.items() if k != "notes"}
        if isinstance(raw_signals, dict)
        else {}
    )

    signal_results = {}
    for sig_name, sig_expected in expected_signals.items():
        observed_val = compute_observed_signal(sig_name, raw_evidence, exec_payload)
        sig_passed = compare_signal_value(sig_name, sig_expected, observed_val)
        signal_results[sig_name] = {
            "expected": sig_expected,
            "observed": observed_val,
            "passed": sig_passed,
        }

    signals_passed = all(entry["passed"] for entry in signal_results.values())
    passed = bool(status_matches and signals_passed)

    return {
        "expected_status": expected_status,
        "observed_status": observed_status,
        "status_matches": status_matches,
        "expected_signals": expected_signals,
        "signal_results": signal_results,
        "signals_passed": signals_passed,
        "passed": passed,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--report", default="harness-lab/report.json")
    parser.add_argument("--rubric", default=os.environ.get("HARNESS_LAB_RUBRIC_PATH", ""))
    parser.add_argument("--board-url", default=os.environ.get("HARNESS_LAB_BOARD_URL", ""))
    parser.add_argument("--token", default=os.environ.get("HARNESS_LAB_BOARD_TOKEN", ""))
    parser.add_argument("--wait-sec", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    base = args.board_url.strip()
    rubric_arg = args.rubric.strip()
    token = args.token.strip()

    if not args.dry_run:
        if not base:
            fail("HARNESS_LAB_BOARD_URL is required; refusing an implicit board")
        if is_production_url(base):
            fail("production-looking board URL rejected")
        if not rubric_arg:
            fail("HARNESS_LAB_RUBRIC_PATH is required; operator-only rubric is missing")
        operator_rubric = load_rubric(rubric_arg)
    else:
        if base and is_production_url(base):
            fail("production-looking board URL rejected")
        operator_rubric = load_rubric(rubric_arg) if rubric_arg else None

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))

    company_id = None
    target_agent_id = None
    if not args.dry_run:
        company_id, comp_status, comp_payload = resolve_company_id(
            base, token, manifest.get("target_company_slug")
        )
        if comp_status != 200 or not company_id:
            fail(f"failed to resolve isolated company on board (http_status={comp_status})")
        target_agent_id = resolve_target_agent(base, token, company_id, args.profile)

    report = {
        "board": "myr-dev-build",
        "board_url": base,
        "company_id": company_id,
        "profile": args.profile,
        "dry_run": args.dry_run,
        "rubric_loaded": operator_rubric is not None,
        "scenarios": [],
    }

    for scenario in manifest["scenarios"]:
        title = scenario.get("title") or scenario.get("name") or scenario["id"]
        item = {"id": scenario["id"], "title": title}
        expected_entry = (operator_rubric or {}).get(scenario["id"], {})

        if args.dry_run:
            item["result"] = "not-run"
            if operator_rubric is not None:
                raw_signals = expected_entry.get("expected_signals")
                item["expected_status"] = expected_entry.get("expected_status") or expected_entry.get("status")
                item["expected_signals"] = (
                    {k: v for k, v in raw_signals.items() if k != "notes"}
                    if isinstance(raw_signals, dict)
                    else {}
                )
            report["scenarios"].append(item)
            continue

        exec_status, exec_payload = api(
            base,
            token,
            "POST",
            "/api/harness/scenarios",
            {"scenario": scenario, "profile": args.profile, "companyId": company_id},
        )
        if exec_status == 404:
            exec_status, exec_payload = find_or_create_scenario_issue(
                base, token, company_id, scenario, expected_entry, target_agent_id
            )

        item["http_status"] = exec_status
        item["response"] = exec_payload

        if exec_status not in (200, 201) or not isinstance(exec_payload, dict):
            item["result"] = "failed"
            item["rubric_check"] = {
                "expected_status": expected_entry.get("expected_status") or expected_entry.get("status"),
                "observed_status": None,
                "status_matches": False,
                "expected_signals": {},
                "signal_results": {},
                "signals_passed": False,
                "passed": False,
                "error": f"Scenario execution HTTP request failed with status {exec_status}",
            }
            report["scenarios"].append(item)
            continue

        task_id = (
            exec_payload.get("taskId")
            or exec_payload.get("issueId")
            or exec_payload.get("task_id")
            or exec_payload.get("issue_id")
            or exec_payload.get("id")
        )
        if not task_id:
            item["result"] = "failed"
            item["rubric_check"] = {
                "expected_status": expected_entry.get("expected_status") or expected_entry.get("status"),
                "observed_status": exec_payload.get("status"),
                "status_matches": False,
                "expected_signals": {},
                "signal_results": {},
                "signals_passed": False,
                "passed": False,
                "error": "Scenario response did not return a task/issue ID for evidence retrieval",
            }
            report["scenarios"].append(item)
            continue

        item["task_id"] = task_id
        evidence, raw_evidence = collect_task_evidence(
            base, token, company_id, task_id, wait_sec=args.wait_sec
        )
        item["evidence"] = evidence

        if evidence["task_http_status"] != 200:
            item["result"] = "failed"
            item["rubric_check"] = {
                "expected_status": expected_entry.get("expected_status") or expected_entry.get("status"),
                "observed_status": None,
                "status_matches": False,
                "expected_signals": {},
                "signal_results": {},
                "signals_passed": False,
                "passed": False,
                "error": f"Failed to retrieve task evidence from board (http_status={evidence['task_http_status']})",
            }
            report["scenarios"].append(item)
            continue

        rubric_check = verify_scenario_rubric(expected_entry, raw_evidence, exec_payload)
        item["rubric_check"] = rubric_check
        item["result"] = "passed" if rubric_check["passed"] else "failed"
        report["scenarios"].append(item)

    distinct_task_ids = sorted(
        {
            s["task_id"]
            for s in report["scenarios"]
            if s.get("result") == "passed" and s.get("task_id")
        }
    )

    report["scenario_count"] = len(report["scenarios"])
    report["executed_count"] = sum(
        1 for s in report["scenarios"] if s.get("result") in ("passed", "failed")
    )
    report["demonstration_count"] = sum(
        1 for s in report["scenarios"] if s.get("result") == "passed" and s.get("task_id")
    )
    report["failed_count"] = sum(
        1 for s in report["scenarios"] if s.get("result") == "failed"
    )
    report["distinct_task_ids"] = distinct_task_ids

    out = Path(args.report)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    summary = {
        "report": str(out),
        "scenario_count": report["scenario_count"],
        "executed_count": report["executed_count"],
        "demonstration_count": report["demonstration_count"],
        "failed_count": report["failed_count"],
        "rubric_loaded": report["rubric_loaded"],
    }
    print(json.dumps(summary))

    if not args.dry_run and (
        report["failed_count"] > 0
        or report["demonstration_count"] < 2
        or len(distinct_task_ids) < 2
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
