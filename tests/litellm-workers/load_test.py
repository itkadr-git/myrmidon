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
if DURATION < 100 or RPS <= 0:
    raise SystemExit("DURATION must be >=100 seconds and RPS must be positive")
BODY = json.dumps({"model": "mock-gpt", "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}).encode()
HEADERS = {"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('LITELLM_API_TOKEN', 'local-test-key')}"}
results = []
lock = threading.Lock()
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
        raise RuntimeError("resize response omitted worker view")
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


events = []
resize_errors = []


def record_resize(phase, target):
    event = {"phase": phase, "target": target, "at_s": round(time.monotonic() - START, 1)}
    try:
        event["result"] = resize(target)
    except Exception as exc:
        message = f"{type(exc).__name__}: {str(exc)[:160]}"
        event["error"] = message
        resize_errors.append(message)
    events.append(event)


START = time.monotonic()
record_resize("start", 2)
STOP = START + DURATION
next_slot = START
threads = [threading.Thread(target=pump, daemon=True) for _ in range(16)]
for thread in threads:
    thread.start()
scale_up_at = START + DURATION * 0.2
scale_down_at = START + DURATION * 0.5
try:
    time.sleep(max(0, scale_up_at - time.monotonic()))
    record_resize("scale_up", 4)
    time.sleep(max(0, scale_down_at - time.monotonic()))
    record_resize("scale_down", 2)
finally:
    for thread in threads:
        thread.join()

codes = {}
for record in results:
    key = str(record["code"])
    codes[key] = codes.get(key, 0) + 1
success = [record for record in results if record["code"] == 200]
errors = [record["err"] for record in results if record["err"]]
phase_latency = {
    "before_resize_s": [r["lat"] for r in success if r["t"] < DURATION * 0.2],
    "four_workers_s": [r["lat"] for r in success if DURATION * 0.25 <= r["t"] < DURATION * 0.5],
    "after_resize_s": [r["lat"] for r in success if r["t"] >= DURATION * 0.55],
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
    "resize_confirmed": [e.get("result", {}).get("current") for e in events] == [2, 4, 2],
    "completed_rps": round(completed_rps, 3), "planned_requests": planned_requests,
    "transport_errors": len(errors), "timeouts": sum("timeout" in e.lower() for e in errors),
    "connection_errors": sum(any(token in e.lower() for token in ("connectionreset", "connectionaborted", "brokenpipe", "remotedisconnected")) for e in errors),
    "elapsed_s": round(elapsed, 3),
    "thread_errors": thread_errors,
    "latency_medians_s": medians, "resize_events": events,
}
output_path = os.path.abspath(OUTPUT)
os.makedirs(os.path.dirname(output_path), exist_ok=True)
temporary_path = output_path + ".tmp"
with open(temporary_path, "w", encoding="utf-8") as output:
    for record in results:
        output.write(json.dumps(record) + "\n")
os.replace(temporary_path, output_path)
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
if any(record["code"] != 200 for record in results):
    failure_reasons.append("non-200 HTTP responses")
if resize_errors:
    failure_reasons.append("worker resize API errors")
if any(value is None for value in medians.values()):
    failure_reasons.append("missing latency phase")
if len(results) != planned_requests:
    failure_reasons.append("completed request count differs from planned attempts")
if completed_rps + 0.05 < RPS:
    failure_reasons.append("completed RPS is below configured aggregate target")
if [e.get("result", {}).get("current") for e in events] != [2, 4, 2]:
    failure_reasons.append("worker resize not confirmed as 2 -> 4 -> 2")
if failure_reasons:
    print("FAIL: " + "; ".join(failure_reasons), file=sys.stderr)
    raise SystemExit(1)
