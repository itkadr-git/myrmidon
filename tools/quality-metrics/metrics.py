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


PAGE_SIZE = 200
MUTATING_ACTION_PREFIXES = (
    "issue.comment", "issue.document", "issue.updated", "issue.blockers",
    "issue.created", "issue.child_created", "issue.work_product",
)
WAIT_RE = re.compile(r"\b(waiting|wait|жду|ожидаю)\b.*\b(CI|deploy|deployment|деплой|выкат|сборк)", re.I)
BLOCKER_RE = re.compile(r"\b(blocked by|блокер|заблокирован из-за|ожидает от)\b", re.I)


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


def paged_audit(root, token, start, end):
    rows = []
    cursor = None
    while True:
        params = {"actorScope": "all", "from": start.isoformat(), "to": end.isoformat(), "limit": PAGE_SIZE}
        if cursor:
            params["cursor"] = cursor
        payload = get_json(root + "/audit/agent-actions", token, params=params)
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise RuntimeError("Audit API returned an unexpected paginated shape")
        rows.extend(
            row for row in payload["items"]
            if within(row, start, end, "createdAt")
        )
        cursor = payload.get("nextCursor")
        if not cursor:
            return rows


def changed_value(details, field, side):
    if not isinstance(details, dict):
        return None
    direct = details.get(field) if side == "to" else None
    if direct is not None:
        return direct
    changes = details.get("changes")
    if isinstance(changes, dict) and isinstance(changes.get(field), dict):
        return changes[field].get(side)
    previous = details.get("_previous") if side == "from" else None
    return previous.get(field) if isinstance(previous, dict) else None


def issue_id_from_audit(row):
    entity = row.get("entity") if isinstance(row.get("entity"), dict) else {}
    issue = entity.get("issue") if isinstance(entity.get("issue"), dict) else {}
    return str(issue.get("id") or (row.get("entityId") if row.get("entityType") == "issue" else ""))


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
    runs = items(get_json(root + "/heartbeat-runs", board_key, params={"limit": PAGE_SIZE, "summary": "true"}), "runs", "items")
    run_times = [parse_time(run.get("createdAt") or run.get("startedAt")) for run in runs]
    oldest_run = min((stamp for stamp in run_times if stamp), default=None)
    if len(runs) >= PAGE_SIZE and (oldest_run is None or oldest_run > args.start):
        raise RuntimeError(f"coverage incomplete: oldest run {oldest_run or 'unknown'} is newer than --from {args.start.isoformat()}")
    runs = [run for run in runs if within(run, args.start, args.end, "startedAt", "createdAt")]
    audit = paged_audit(root, board_key, args.start, args.end)

    run_ids = {str(run.get("id")) for run in runs}
    by_run = {run_id: [] for run_id in run_ids}
    for row in audit:
        run_id = str(row.get("runId") or "")
        action = str(row.get("action", ""))
        if run_id in by_run and action.startswith(MUTATING_ACTION_PREFIXES):
            by_run[run_id].append(row)
    idle = sum(not events for events in by_run.values())

    issue_ids = {issue_id_from_audit(row) for row in audit if issue_id_from_audit(row)}
    issues, issue_comments = {}, {}
    for issue_id in issue_ids:
        issue_payload = get_json(f"{board}/api/issues/{urllib.parse.quote(issue_id, safe='')}", board_key)
        issues[issue_id] = issue_payload.get("issue", issue_payload) if isinstance(issue_payload, dict) else issue_payload
        comments_payload = get_json(f"{board}/api/issues/{urllib.parse.quote(issue_id, safe='')}/comments", board_key, params={"order": "asc", "limit": PAGE_SIZE})
        issue_comments[issue_id] = items(comments_payload, "comments", "items")

    blocked = bypass = waiting = 0
    for row in audit:
        details = row.get("details") if isinstance(row.get("details"), dict) else {}
        issue_id = issue_id_from_audit(row)
        status_to = str(changed_value(details, "status", "to") or "").lower()
        status_from = str(changed_value(details, "status", "from") or "").lower()
        event_time = parse_time(row.get("createdAt"))
        if issue_id and status_to == "blocked" and status_from != "blocked":
            blockers = changed_value(details, "blockedByIssueIds", "to") or []
            metadata = changed_value(details, "blockerMetadata", "to")
            named = any(
                BLOCKER_RE.search(str(comment.get("body", "")))
                and (not event_time or (parse_time(comment.get("createdAt")) or event_time) <= event_time)
                for comment in issue_comments.get(issue_id, [])
            )
            if not blockers and not metadata and not named:
                blocked += 1
        if issue_id and status_to == "in_review" and status_from != "in_review":
            if changed_value(details, "reviewPolicy", "to") == "human_only":
                bypass += 1

    for issue_id, issue in issues.items():
        if not issue.get("monitorNextCheckAt"):
            waiting += sum(
                bool(WAIT_RE.search(str(comment.get("body", ""))))
                and within(comment, args.start, args.end, "createdAt")
                for comment in issue_comments.get(issue_id, [])
            )

    spend = 0.0
    page = 1
    spend_params = {"page": page, "page_size": 1000, "start_date": args.start.strftime("%Y-%m-%d %H:%M:%S"), "end_date": args.end.strftime("%Y-%m-%d %H:%M:%S")}
    while True:
        spend_payload = get_json(llm_base + "/spend/logs/v2", llm_key, params=spend_params)
        for row in items(spend_payload, "data", "spend_logs", "items"):
            alias = os.environ.get("LITELLM_KEY_ALIAS")
            if not alias or row.get("key_alias") == alias:
                spend += float(row.get("spend") or 0)
        total_pages = int(spend_payload.get("total_pages", page)) if isinstance(spend_payload, dict) else page
        if page >= total_pages:
            break
        page += 1
        spend_params["page"] = page

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
