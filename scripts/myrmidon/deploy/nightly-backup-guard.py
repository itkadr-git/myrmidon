#!/usr/bin/env python3
import datetime
import json
import re
import sys
import time


def main():
    archives = []
    for line in sys.stdin:
        token = line.split()[0] if line.split() else ""
        if token.startswith("pbs-offsite:backup/vm/100/"):
            stamp = token.removeprefix("pbs-offsite:backup/vm/100/")
            if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", stamp):
                raise ValueError("invalid archive timestamp")
            archives.append((int(datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()), token))
    if not archives:
        raise ValueError("no VM 100 archives")
    archives.sort()
    start, volid = archives[-1]
    if sum(t == start for t, _ in archives) != 1:
        raise ValueError("ambiguous latest archive")
    now = int(time.time())
    if not 0 <= now - start <= 36 * 3600:
        raise ValueError("archive stale or in future")
    tasks = json.loads(sys.argv[1])
    if not isinstance(tasks, list):
        raise ValueError("invalid task list")
    eligible = [t for t in tasks if isinstance(t, dict) and str(t.get("id")) == "100" and t.get("node") == "hk01" and t.get("type") == "vzdump" and t.get("status") == "OK" and type(t.get("starttime")) is int and type(t.get("endtime")) is int]
    if not eligible:
        raise ValueError("no completed VM backup task")
    latest = max(t["starttime"] for t in eligible)
    matches = [t for t in eligible if t["starttime"] == latest]
    if latest != start or len(matches) != 1 or not start <= matches[0]["endtime"] <= now:
        raise ValueError("archive and task mismatch or invalid endtime")
    print(f"PBS verified: {volid}; completed={matches[0]['endtime']}; age={now-start}s")


try:
    main()
except (ValueError, TypeError, IndexError, json.JSONDecodeError) as exc:
    print(f"PBS guard NO-GO: {exc}", file=sys.stderr)
    sys.exit(1)
