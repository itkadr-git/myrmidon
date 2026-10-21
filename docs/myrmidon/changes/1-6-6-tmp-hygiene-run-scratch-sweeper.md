---
settings-section: 1.6.6 — TMP-HYGIENE
---

## changelog-en

### Orphaned run scratch directories are swept and measured

The board now removes orphaned heartbeat run scratch directories (`paperclip-run-*` in the temp directory) on a timer. Only directories that carry the run marker file and are older than the TTL are removed; unmarked directories are never touched. The volume is exported on `/metrics`: `myrmidon_run_scratch_removed_dirs_total`, `myrmidon_run_scratch_removed_bytes_total`, `myrmidon_run_scratch_remaining_dirs`, `myrmidon_run_scratch_remaining_bytes`.

## changelog-ru

### Осиротевшие каталоги запусков чистятся и измеряются

Доска по таймеру удаляет осиротевшие временные каталоги запусков heartbeat (`paperclip-run-*` во временном каталоге). Удаляются только каталоги с маркером запуска старше срока жизни; каталоги без маркера не трогаются. Объём виден в `/metrics`: `myrmidon_run_scratch_removed_dirs_total`, `myrmidon_run_scratch_removed_bytes_total`, `myrmidon_run_scratch_remaining_dirs`, `myrmidon_run_scratch_remaining_bytes`.

## settings-en

| `MYRMIDON_RUN_SCRATCH_SWEEP_INTERVAL_MINUTES` | TMP-HYGIENE | 15 | How often the janitor of orphaned heartbeat run scratch directories runs (the first pass runs at startup) | Unset, non-numeric or not positive — the default is used. Read at server startup |
| `MYRMIDON_RUN_SCRATCH_TTL_HOURS` | TMP-HYGIENE | 36 | Age after which a marked run scratch directory is considered orphaned and removed. Must exceed the longest expected run | Unset, non-numeric or not positive — the default is used. Read at server startup |

## settings-ru

| `MYRMIDON_RUN_SCRATCH_SWEEP_INTERVAL_MINUTES` | TMP-HYGIENE | 15 | Как часто работает сторож осиротевших временных каталогов запусков heartbeat (первый проход — при старте) | Не задано, не число или не положительное — берётся значение по умолчанию. Читается при старте сервера |
| `MYRMIDON_RUN_SCRATCH_TTL_HOURS` | TMP-HYGIENE | 36 | Возраст, после которого каталог запуска с маркером считается осиротевшим и удаляется. Должен превышать самый долгий ожидаемый запуск | Не задано, не число или не положительное — берётся значение по умолчанию. Читается при старте сервера |
