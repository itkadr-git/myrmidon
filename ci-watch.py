import json, os, sys, time, urllib.request
REPO = "itkadr-git/myrmidon"
SHA = sys.argv[1]
BUDGET = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
def get(path):
    req = urllib.request.Request("https://api.github.com" + path,
        headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
                 "User-Agent": "ci-watch"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)
started = time.time()
while True:
    try:
        data = get(f"/repos/{REPO}/commits/{SHA}/check-runs?per_page=100")
        runs = data.get("check_runs", [])
        by = {}
        for r in runs:
            k = r.get("conclusion") or r.get("status")
            by[k] = by.get(k, 0) + 1
        pending = [r["name"] for r in runs if r.get("status") != "completed"]
        failed = [f'{r["name"]}:{r.get("conclusion")}' for r in runs if r.get("conclusion") in ("failure", "cancelled", "timed_out", "action_required")]
        print(f"[{int(time.time()-started)}s] total={len(runs)} {by} pending={len(pending)} failed={failed}", flush=True)
        if runs and not pending:
            print("DONE", json.dumps(by), flush=True)
            break
        if time.time() - started > BUDGET:
            print("TIMEOUT", flush=True)
            break
    except Exception as exc:
        print("poll error:", exc, flush=True)
    time.sleep(45)
