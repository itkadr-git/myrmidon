---
'@myrmidon/server': patch
---

Extend the old-authority outbox acknowledgement wait with the same renewable window used for the terminal result wait (#2558, OPE-12021): each cumulative ACK that advances the cursor re-arms the 2 s window (capped at 10 s total), so a controller slowly committing the retained event backlog no longer trips the fixed 2 s fence during warm authority rotation. A repeated ACK without progress is not a liveness signal and does not extend the window; a silent controller still times out one window after its last advancing ACK, never later than the hard cap. The window arithmetic lives in the pure `terminal_result_ack_deadline` helper from #2558, now shared by both waits, with unit tests on synthetic `Instant`s.
