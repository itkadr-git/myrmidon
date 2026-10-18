---
settings-section: Track 4 — chats and skills
---

## settings-en

| `MYRMIDON_KNOWLEDGE_EXPORT_REPO` | L-8 | unset (disabled) | Enables the nightly deterministic Git export of the knowledge tree to this repository. | Unset disables export; configure a repository URL explicitly. |
| `MYRMIDON_KNOWLEDGE_EXPORT_BRANCH` | L-8 | `knowledge-export` | Branch used for the exported knowledge snapshot. | Invalid branch names fall back to the default. |
| `MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS` | L-8 | `24` | Hours between nightly knowledge export runs. | Invalid or non-positive values fall back to 24 hours. |
