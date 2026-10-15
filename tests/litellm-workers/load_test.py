#!/usr/bin/env python3
"""Send constant aggregate RPS while resizing workers through the board API.

Required environment: BASE_URL, COMPANY_ID, BOARD_API_URL, BOARD_API_TOKEN.
Optional: DURATION (seconds), RPS (aggregate), OUTPUT (JSONL path).
"""
import json
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = os.environ["BASE_URL"].rstrip("/")
COMPANY_ID = os.environ["COMPANY_ID"]
API_URL = os.environ["BOARD_API_URL"].rstrip("/")
API_TOKEN = os.environ["BOARD_API_TOKEN"]
DURATION = float(os.environ.get("DURATION", "150"))
RPS = float(os.environ.get("RPS", "8"))
OUTPUT = os.environ.get("OUTPUT", "ope6419-results.jsonl")
if DURATION < 70 or RPS <= 0:
    raise SystemExit("DURATION must be >=70 seconds and RPS must be positive")
START = time.monotonic()
STOP = START + DURATION
BODY = json.dumps({"model": "mock-gpt", "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}).encode()
HEADERS = {"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('LITELLM_API_TOKEN', 'local-test-key')}"}
results = []
lock = threading.Lock()
next_slot = START
slot_lock = threading.Lock()
thread_errors = []


def resize(target):
    request = urllib.request.Request(
        f"{API_URL}/api/myrmidon/companies/{COMPANY_ID}/litellm/workers",
        data=json.dumps({"target": target}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_TOKEN}"},
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read())
    view = payload.get("view")
    if not isinstance(view, dict):
        raise RuntimeError("resize response omitted view")
    if view.get("target") != target or payload.get("applied") is not True:
        raise RuntimeError(f"resize to {target} not applied")
    if view.get("current") != target or view.get("currentSource") != "gateway":
        raise RuntimeError(f"gateway did not confirm worker count {target}")
    return {"target": view["target"], "current": view["current"], "currentSource": view["currentSource"], "applied": payload["applied"]}


def request_once(scheduled):
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
    record = {"t": round(time.monotonic() - START, 2), "scheduled_t": round(scheduled - START, 2),
              "code": status, "lat": round(time.monotonic() - started, 3), "err": error}
    with lock:
        results.append(record)


def pump():
    global next_slot
    interval = 1.0 / RPS
    try:
        while True:
            with slot_lock:
                scheduled = next_slot
                next_slot += interval
            if scheduled >= STOP:
                return
            delay = scheduled - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            request_once(scheduled)
    except Exception as exc:
        with lock:
            thread_errors.append(f"{type(exc).__name__}: {str(exc)[:120]}")


events = [{"phase": "start", "target": 2, "at_s": 0, "result": resize(2)}]
threads = [threading.Thread(target=pump, daemon=True) for _ in range(16)]
for thread in threads:
    thread.start()
time.sleep(30)
events.append({"phase": "scale_up", "target": 4, "at_s": round(time.monotonic() - START, 1), "result": resize(4)})
time.sleep(40)
events.append({"phase": "scale_down", "target": 2, "at_s": round(time.monotonic() - START, 1), "result": resize(2)})
for thread in threads:
    thread.join(timeout=max(0, STOP - time.monotonic()) + 35)
if any(thread.is_alive() for thread in threads):
    raise RuntimeError("load worker threads did not finish")

codes = {}
for record in results:
    key = str(record["code"])
    codes[key] = codes.get(key, 0) + 1
success = [record for record in results if record["code"] == 200]
errors = [record["err"] for record in results if record["err"]]
phase_latency = {
    "before_resize_s": [r["lat"] for r in success if r["t"] < 30],
    "four_workers_s": [r["lat"] for r in success if 35 <= r["t"] < 70],
    "after_resize_s": [r["lat"] for r in success if r["t"] >= 75],
}
medians = {name: round(statistics.median(values), 3) if values else None
           for name, values in phase_latency.items()}
http_5xx = sum(count for code, count in codes.items() if int(code) >= 500)
elapsed = max((r["t"] for r in results), default=0)
planned_requests = int(DURATION * RPS)
attempted_rps = planned_requests / DURATION
completed_rps = len(results) / DURATION
summary = {
    "duration_s": DURATION, "target_rps": RPS, "attempted_requests": planned_requests,
    "completed_requests": len(results), "attempted_rps": round(attempted_rps, 3),
    "codes": codes, "http_5xx": http_5xx,
    "worker_current_events": [e.get("result", {}).get("current") for e in events],
    "completed_rps": round(completed_rps, 3), "planned_requests": planned_requests,
    "transport_errors": len(errors), "timeouts": sum("timeout" in e.lower() for e in errors),
    "thread_errors": thread_errors,
    "latency_medians_s": medians, "resize_events": events,
}
output_path = os.path.abspath(OUTPUT)
os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "w", encoding="utf-8") as output:
    for record in results:
        output.write(json.dumps(record) + "\n")
print(json.dumps(summary, indent=2))
failure_reasons = []
if http_5xx:
    failure_reasons.append("HTTP 5xx responses")
if errors:
    failure_reasons.append("transport errors")
if thread_errors:
    failure_reasons.append("load thread errors")
if not success:
    failure_reasons.append("no successful responses")
if any(value is None for value in medians.values()):
    failure_reasons.append("missing latency phase")
if len(results) != planned_requests:
    failure_reasons.append("completed request count differs from planned attempts")
if [e.get("result", {}).get("current") for e in events] != [2, 4, 2]:
    failure_reasons.append("worker resize not confirmed as 2 -> 4 -> 2")
if failure_reasons:
    print("FAIL: " + "; ".join(failure_reasons), file=sys.stderr)
    raise SystemExit(1)
