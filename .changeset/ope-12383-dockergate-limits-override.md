---
'@myrmidon/server': patch
---

Bot resource-ceiling updates no longer fail as an opaque dockergate upstream error when dockergate's config file is mounted read-only: the gate now writes the mutable per-bot limits (and the ceilings the first update pinned) to a separate limits-override file on the writable state bind (`limitsOverrideFile` in config.json; fresh installs point it at `/run/myrmidon-dockergate-state/limits.json`), never rewriting the read-only main config, and refuses an update it cannot persist with `config_read_only` (HTTP 403) instead of `upstream_error` (502), which the board driver surfaces as a clear operator-facing fault instead of a retried upstream failure.
