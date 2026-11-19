---
"@myrmidon/server": patch
---

Gateway slot reconcile now ends its pass at the first unreachable probe instead of probing up to 64 runs against a gateway that is down, so a dark gateway no longer delays run starts or re-resolves the agent's secrets once per row.
