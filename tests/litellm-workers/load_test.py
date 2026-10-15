#!/usr/bin/env python3
"""Drive constant-rate traffic while adjusting direct Gunicorn workers.

Usage: python3 load_test.py BASE_URL MASTER_PID [duration_s] [rps]
Writes per-request JSON lines to ope6419-results.jsonl and prints a summary.
"""
import json
import os
import signal
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/")
MASTER = int(sys.argv[2])
DURATION = float(sys.argv[3]) if len(sys.argv) > 3 else 150.0
RPS = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0
START = time.monotonic()
STOP = START + DURATION
BODY = json.dumps({"model": "mock-gpt", "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}).encode()
HEADERS = {"Content-Type": "application/json", "Authorization": "Bearer local-test-key"}
results = []
lock = threading.Lock()


def worker_count():
    result = subprocess.run(["pgrep", "-P", str(MASTER)], capture_output=True, text=True, check=False)
    return len(result.stdout.splitlines())


def request_once():
    started = time.monotonic()
    status, error = 0, None
    try:
        request = urllib.request.Request(BASE + "/chat/completions", data=BODY, headers=HEADERS, method="POST")
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.read()
    except Exception as exc:
        error = f"{type(exc).__name__}: {str(exc)[:120]}"
    record = {"t": round(time.monotonic() - START, 2), "code": status,
              "lat": round(time.monotonic() - started, 3), "err": error}
    with lock:
        results.append(record)


def pump():
    interval = 1.0 / RPS
    next_request = time.monotonic()
    while time.monotonic() < STOP:
        request_once()
        next_request += interval
        delay = next_request - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_request = time.monotonic()


threads = [threading.Thread(target=pump, daemon=True) for _ in range(4)]
for thread in threads:
    thread.start()

events = [("start", worker_count(), round(time.monotonic() - START, 1))]
time.sleep(min(30, max(0, STOP - time.monotonic())))
os.kill(MASTER, signal.SIGTTIN)
time.sleep(2)
os.kill(MASTER, signal.SIGTTIN)
time.sleep(3)
events.append(("after +2", worker_count(), round(time.monotonic() - START, 1)))
time.sleep(min(40, max(0, STOP - time.monotonic())))
os.kill(MASTER, signal.SIGTTOU)
time.sleep(2)
os.kill(MASTER, signal.SIGTTOU)
time.sleep(3)
events.append(("after -2", worker_count(), round(time.monotonic() - START, 1)))
for thread in threads:
    thread.join(timeout=max(0, STOP - time.monotonic()) + 60)

codes = {}
for record in results:
    key = str(record["code"])
    codes[key] = codes.get(key, 0) + 1
success = [record["lat"] for record in results if record["code"] == 200]
errors = [record["err"] for record in results if record["err"]]
summary = {
    "duration_s": DURATION, "target_rps": RPS, "total_requests": len(results),
    "codes": codes, "http_5xx": sum(int(code) >= 500 for code in codes),
    "timeouts": sum("timeout" in error.lower() for error in errors),
    "conn_errors": sum("connection" in error.lower() or "reset" in error.lower() for error in errors),
    "latency_median_200_s": round(statistics.median(success), 3) if success else None,
    "worker_count_events": events,
}
print(json.dumps(summary, indent=2))
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ope6419-results.jsonl"), "w") as output:
    for record in results:
        output.write(json.dumps(record) + "\n")
