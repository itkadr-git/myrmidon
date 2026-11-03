---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_API_MAX_OLD_SPACE_MB` | BOARD-PROCESSES (OPE-10011) | unset (`1024`) | V8 old-space ceiling, MB, passed as `--max-old-space-size` to each api child the worker forks in `split`. Read by the worker when it forks a child | Unset, non-integer or outside `256..8192` — the default `1024` |

## settings-ru

| `MYRMIDON_API_MAX_OLD_SPACE_MB` | BOARD-PROCESSES (OPE-10011) | не задана (`1024`) | Потолок old-space V8 в МБ, передаётся как `--max-old-space-size` каждому api-ребёнку, которого worker форкает в режиме `split`. Worker читает его при форке ребёнка | Не задана, не целое число или вне `256..8192` — действует умолчание `1024` |
