---
'@myrmidon/server': patch
---

Host disk threshold signal (OPE-12958): the sweep wrote the `host.disk_threshold_exceeded` activity line without a company, which violates the NOT NULL `company_id` column, so the write failed on every sweep and the signal interval never started. The line is now written once per company, like the other instance-level host-disk lines; with no company the sweep skips the write and logs once, and a failed write is logged instead of aborting the measurement result.
