---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_RELEASE_AUDIT_FILE` | R5-A | unset | Optional explicit path to the append-only deploy release audit JSONL file. When unset, the server reads `release-events.jsonl` from `MYRMIDON_DEPLOY_REPORTS_DIR` if configured; otherwise audit history is unavailable to the board | Unset — derive from reports directory, or disable audit reads when neither path is configured |
