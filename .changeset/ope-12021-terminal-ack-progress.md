---
'@myrmidon/server': patch
---

Keep the runner terminal-result acknowledgement wait alive while the controller is still advancing its event acknowledgement cursor ahead of that result, instead of timing out one fixed window after the result was sent. A silent controller, or one that only repeats an old acknowledgement, still times out one window after its last progress, and never later than 10 seconds in total.
