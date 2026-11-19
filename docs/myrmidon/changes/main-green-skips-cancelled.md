---
settings-section: Track 5 — operations
---

## changelog-en

### CI: the main-green gate skips cancelled main runs (OPE-13461)

- The `main-green` check no longer turns red because the latest completed main CI run was `cancelled`. Merges into `main` come every few minutes, and each one cancels the running main CI through `concurrency`, so most completed runs are `cancelled`.
- The verdict is now the newest completed run with a real result: `success` is green; `failure`, `timed_out` and `startup_failure` are red. `cancelled` and `skipped` runs are skipped over.
- The gate reads up to 100 runs (and a second page when needed) from the last 24 hours. If there is no non-cancelled completed run, the gate fails closed (red) with the reason "no non-cancelled completed run".
- Unchanged: an open `main-red` issue keeps the gate red, the stale-green protection, fail-closed on API errors, and the `--status` mode.
- On 16.11 reviewers returned 6 runs of OPE-13380 and 4 of OPE-13351 with REQUEST CHANGES only because of a cancelled main CI run.

## changelog-ru

### CI: проверка main-green пропускает отменённые прогоны main (OPE-13461)

- Проверка `main-green` больше не краснеет из-за того, что последний завершённый прогон CI main отменён (`cancelled`). Вливания в `main` идут каждые несколько минут, и каждое отменяет идущий прогон CI main через `concurrency`, поэтому большинство завершённых прогонов — `cancelled`.
- Вердикт даёт последний завершённый прогон с настоящим результатом: `success` — зелёный; `failure`, `timed_out`, `startup_failure` — красный. Прогоны `cancelled` и `skipped` пропускаются.
- Проверка читает до 100 прогонов (и вторую страницу при необходимости) за последние 24 часа. Если не отменённого завершённого прогона нет, проверка закрывается красным (fail closed) с причиной «no non-cancelled completed run».
- Без изменений: открытый тикет `main-red` держит красный, защита от устаревшего зелёного, красный при ошибках API, режим `--status`.
- 16.11 ревьюеры вернули 6 прогонов OPE-13380 и 4 прогона OPE-13351 с REQUEST CHANGES только из-за отменённого CI main.
