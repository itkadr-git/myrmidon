---
'@myrmidon/server': patch
---

Keep the runner terminal-result acknowledgement wait alive while the controller is still acknowledging the retained event backlog queued ahead of that result, instead of timing out one fixed window after the result was sent. A silent controller still times out one window after its last acknowledgement, and never later than 10 seconds in total.
