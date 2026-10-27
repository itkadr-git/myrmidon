---
'@myrmidon/server': patch
---

Add an opt-in Linux reviewer-context isolation prototype with a fresh HOME and workspace, explicit task/diff handoff, and Landlock filesystem confinement. An end-to-end canary test verifies executor files and session history cannot be read. Production gateway behavior is unchanged.
