#!/usr/bin/env python3
"""Run the reference scenarios against an explicitly isolated board."""
import argparse, json, os, sys, urllib.error, urllib.request
from pathlib import Path

PROD_MARKERS = ("10.10.10.2:3100", "paperclip.prod", "/production")
ROOT = Path(__file__).resolve().parent

def fail(message):
    raise SystemExit(f"harness-lab: {message}")

def api(base, token, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        return exc.code, {"error": exc.read().decode(errors="replace")[:500]}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--report", default="harness-lab/report.json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    base = os.environ.get("HARNESS_LAB_BOARD_URL", "").strip()
    rubric = os.environ.get("HARNESS_LAB_RUBRIC_PATH", "").strip()
    if not args.dry_run:
        if not base:
            fail("HARNESS_LAB_BOARD_URL is required; refusing an implicit board")
        if any(marker in base.lower() for marker in PROD_MARKERS):
            fail("production-looking board URL rejected")
        if not rubric:
            fail("HARNESS_LAB_RUBRIC_PATH is required; operator-only rubric is missing")
        rubric_path = Path(rubric)
        if not rubric_path.is_file():
            fail("operator-only rubric is not readable")
    elif base and any(marker in base.lower() for marker in PROD_MARKERS):
        fail("production-looking board URL rejected")
    manifest = json.loads((ROOT / "manifest.json").read_text())
    token = os.environ.get("HARNESS_LAB_BOARD_TOKEN")
    operator_rubric = json.loads(Path(rubric).read_text()) if not args.dry_run else None
    report = {"board":"myr-dev-build", "board_url":base, "profile":args.profile, "scenarios":[]}
    for scenario in manifest["scenarios"]:
        item = {"id":scenario["id"], "title":scenario["title"]}
        if args.dry_run:
            item["result"] = "not-run"
        else:
            status, payload = api(base, token, "POST", "/api/harness/scenarios", {"scenario":scenario, "profile":args.profile})
            item.update({"http_status":status, "response":payload})
            expected = operator_rubric.get(scenario["id"], {})
            item["rubric_check"] = {"expected_status":expected.get("status"), "observed_status":payload.get("status"), "passed":payload.get("status") == expected.get("status")}
        report["scenarios"].append(item)
    report["scenario_count"] = len(report["scenarios"])
    report["demonstration_count"] = sum(1 for x in report["scenarios"] if x.get("result") != "not-run")
    out = Path(args.report)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps({"report":str(out), "scenario_count":report["scenario_count"], "demonstration_count":report["demonstration_count"]}))

if __name__ == "__main__":
    main()
