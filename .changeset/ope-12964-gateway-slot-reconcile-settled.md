---
'@myrmidon/server': patch
---

Gateway slot reconcile now remembers board runs whose gateway run was confirmed finished or stopped and no longer probes them on every pass. Each probe re-resolved the agent's secrets and wrote secret access audit rows, producing millions of rows a day. An unreachable probe also ends the pass instead of probing every remaining run.
