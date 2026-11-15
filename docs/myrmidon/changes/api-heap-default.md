## changelog-en

### The api child heap ceiling defaults to 2560 MB (OPE-13266)

- Each api child of the split board now starts with `--max-old-space-size=2560` (was 1024). The startup heap of the api process reached about 1 GB by 2026-11-15, and production children died with OOM 10-25 s after ready. `MYRMIDON_API_MAX_OLD_SPACE_MB` still overrides it; the accepted range stays 256..8192.

## changelog-ru

### Потолок кучи дочернего api-процесса по умолчанию — 2560 МБ (OPE-13266)

- Каждый дочерний api-процесс разделённой доски теперь стартует с `--max-old-space-size=2560` (было 1024). Стартовый объём кучи api-процесса к 15.11.2026 дорос примерно до 1 ГБ, и на бою дочерние процессы падали по OOM через 10-25 с после готовности. `MYRMIDON_API_MAX_OLD_SPACE_MB` по-прежнему переопределяет значение; допустимый диапазон остаётся 256..8192.

## settings-en-replace

| `MYRMIDON_API_MAX_OLD_SPACE_MB` | BOARD-PROCESSES (OPE-10011) | `2560` (unset) | V8 old-space ceiling, MB, passed as `--max-old-space-size` to each api child the worker forks in `split`. Read by the worker when it forks a child | Unset, non-integer or outside `256..8192` — the default `2560` |

## settings-ru-replace

| `MYRMIDON_API_MAX_OLD_SPACE_MB` | BOARD-PROCESSES (OPE-10011) | `2560` (не задана) | Потолок old-space V8 в МБ, передаётся как `--max-old-space-size` каждому api-ребёнку, которого worker форкает в режиме `split`. Worker читает его при форке ребёнка | Не задана, не целое число или вне `256..8192` — действует умолчание `2560` |
