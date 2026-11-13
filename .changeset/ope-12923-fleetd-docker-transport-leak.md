---
'@myrmidon/server': patch
---

fleetd (OPE-12923): stop the memory leak that OOM-killed the site agent on myr-vm1. Every Docker API call (request, pull, logs) built a throwaway `http.Transport` whose pooled keep-alive connection pinned its connection goroutines forever, so fleetd grew without limit (~45 MB/h at rest, ~220 MB/h during a bot roll) until the OOM killer fired at MemoryMax. All Docker calls now share one transport with a bounded idle pool (`IdleConnTimeout` 1m); per-call budgets stay the same (30s request/logs, 15m pull). A regression test hammers 1000 recreate/profile/status cycles against a fake Docker socket and fails when goroutines or GC'd heap grow (limit: 20 MB above the 10-cycle baseline).
