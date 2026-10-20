#!/usr/bin/env python3
"""Report run-quality rates from Paperclip and spend from LiteLLM."""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


def date_arg(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid ISO-8601 date: {value}") from exc


def get_json(url, token, *, params=None):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"GET failed for {urllib.parse.urlsplit(url).path}: {exc}") from exc


def items(payload, *keys):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in keys:
            if isinstance(payload.get(key), list):
                return payload[key]
    raise RuntimeError("Unexpected API response collection shape")


def parse_time(value):
    if not value:
        return None
    try:
        result = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.replace(tzinfo=dt.timezone.utc) if result.tzinfo is None else result.astimezone(dt.timezone.utc)
    except ValueError:
        return None


def within(record, start, end, *fields):
    stamp = next((parse_time(record.get(f)) for f in fields if record.get(f)), None)
    return stamp is not None and start <= stamp < end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="start", required=True, type=date_arg)
    parser.add_argument("--to", dest="end", required=True, type=date_arg)
    args = parser.parse_args()
    if args.end <= args.start:
        parser.error("--to must be later than --from")
    board = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    board_key = os.environ.get("PAPERCLIP_API_KEY")
    company = os.environ.get("PAPERCLIP_COMPANY_ID")
    llm_base = os.environ.get("LITELLM_API_BASE", "").rstrip("/")
    llm_key = os.environ.get("LITELLM_API_KEY")
    if not all((board, board_key, company, llm_base, llm_key)):
        parser.error("set PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, LITELLM_API_BASE, and LITELLM_API_KEY")
    assert company is not None
    root = f"{board}/api/companies/{urllib.parse.quote(company, safe='')}"
    runs = items(get_json(root + "/heartbeat-runs", board_key, params={"limit": 1000, "summary": "true"}), "runs", "items")
    runs = [r for r in runs if within(r, args.start, args.end, "startedAt", "createdAt")]
    activities = items(get_json(root + "/activity", board_key, params={"limit": 500}), "items", "activity")
    issues = items(get_json(root + "/issues", board_key, params={"limit": 500}), "items", "issues")
    issue_comments = {}
    for issue in issues:
        ident = issue.get("id") or issue.get("identifier")
        if ident:
            comments = get_json(f"{board}/api/issues/{urllib.parse.quote(str(ident), safe='')}/comments", board_key, params={"order": "asc", "limit": 500})
            issue_comments[str(ident)] = items(comments, "comments", "items")
    run_ids = {str(r.get("id")) for r in runs}
    by_run = {rid: [] for rid in run_ids}
    for act in activities:
        if str(act.get("runId")) in by_run and within(act, args.start, args.end, "createdAt", "timestamp"):
            by_run[str(act["runId"])].append(act)
    idle = sum(not by_run[rid] for rid in run_ids)
    issue_by_id = {str(i.get("id")): i for i in issues}
    blocked = bypass = waiting = 0
    wait_re = re.compile(r"\b(waiting|wait|жду|ожидаю)\b.*\b(CI|deploy|deployment|деплой|выкат|сборк)", re.I)
    blocker_re = re.compile(r"\b(blocked by|блокер|заблокирован из-за|ожидает от)\b", re.I)
    for act in activities:
        if not within(act, args.start, args.end, "createdAt", "timestamp"):
            continue
        details = act.get("details") if isinstance(act.get("details"), dict) else {}
        entity_id = str(act.get("entityId") or details.get("issueId") or "")
        issue = issue_by_id.get(entity_id)
        action = str(act.get("action", "")).lower()
        status = str(details.get("status") or details.get("toStatus") or "").lower()
        if issue and (status == "blocked" or "blocked" in action):
            ids = issue.get("blockedByIssueIds") or []
            meta = issue.get("blockerMetadata")
            all_comments = issue_comments.get(entity_id, [])
            named = any(blocker_re.search(str(c.get("body", ""))) and within(c, args.start, args.end, "createdAt") for c in all_comments)
            if not ids and not meta and not named:
                blocked += 1
        if issue and (status == "in_review" or "in_review" in action) and issue.get("reviewPolicy") == "human_only":
            bypass += 1
    for issue in issues:
        ident = str(issue.get("id") or issue.get("identifier") or "")
        no_monitor = not issue.get("monitorNextCheckAt")
        if no_monitor:
            for comment in issue_comments.get(ident, []):
                body = str(comment.get("body", ""))
                if wait_re.search(body) and within(comment, args.start, args.end, "createdAt"):
                    waiting += 1
    spend_data = get_json(llm_base + "/spend/logs", llm_key, params={"start_date": args.start.isoformat(), "end_date": args.end.isoformat()})
    spend_rows = items(spend_data, "spend_logs", "data", "items")
    spend = 0.0
    for row in spend_rows:
        start = parse_time(row.get("startTime") or row.get("start_time"))
        end = parse_time(row.get("endTime") or row.get("end_time"))
        if (start is None or start < args.end) and (end is None or end >= args.start):
            spend += float(row.get("spend") or 0)
    total = len(runs)
    period = f"{args.start.isoformat()} – {args.end.isoformat()}"
    metrics = [("Idle runs", idle), ("Blocked without reason", blocked), ("Review gate bypass proxy", bypass), ("Waiting without monitor", waiting)]
    print(f"{'Metric':<30} {'Value':>12} {'Rate of runs':>14}  Period")
    for name, count in metrics:
        rate = count / total if total else 0
        print(f"{name:<30} {count:>12} {rate:>13.1%}  {period}")
    print(f"{'LiteLLM spend (USD)':<30} {spend:>12.4f} {'n/a':>14}  {period}")
    print(f"Runs denominator: {total}")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
