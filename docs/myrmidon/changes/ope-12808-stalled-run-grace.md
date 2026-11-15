---
settings-section: Track 2 — wake and run core
---

## changelog-en

### Stalled run keeps its credentials for a grace window (RUN-STALL, OPE-12808)

- A run interrupted by the stall sweep (status `cancelled`, error code `run_stalled`) can still obtain its credentials for `MYRMIDON_RUN_STALL_GRACE_SEC` seconds (default 600), so an agent that was only quiet can push and report. After the window the board refuses with the named `run_stalled` reason instead of a bare 403.

## changelog-ru

### Прерванный по зависанию прогон сохраняет учётные данные на льготное окно (RUN-STALL, OPE-12808)

- Прогон, прерванный сканом зависаний (статус `cancelled`, код ошибки `run_stalled`), ещё `MYRMIDON_RUN_STALL_GRACE_SEC` секунд (по умолчанию 600) может получить свои учётные данные, чтобы молчавший агент успел запушить и отчитаться. После окна доска отказывает с именованной причиной `run_stalled`, а не голым 403.

## settings-en

| `MYRMIDON_RUN_STALL_GRACE_SEC` | RUN-STALL | `600` (10 min) | Grace window after the stall sweep interrupts a run: for this many seconds the interrupted run (status `cancelled`, error code `run_stalled`) can still obtain its credentials, so an agent that was only quiet (a long sync or build) can push and report. After the window, or for any other terminal run, the board refuses with the named `run_stalled` reason instead of a bare 403. No process is killed | Whole seconds, `0` — no grace (refuse right away). Unset, empty, non-numeric, negative or infinite — the default (600); a fractional value is rounded down |

## settings-ru

| `MYRMIDON_RUN_STALL_GRACE_SEC` | RUN-STALL | `600` (10 мин) | Льготное окно после прерывания прогона сканом зависаний: столько секунд прерванный прогон (статус `cancelled`, код ошибки `run_stalled`) ещё может получить свои учётные данные, чтобы агент, который лишь молчал (долгая синхронизация или сборка), успел запушить и отчитаться. После окна, как и для любого другого завершённого прогона, доска отказывает с названной причиной `run_stalled`, а не голым 403. Процесс не убивается | Целые секунды, `0` — без окна (отказ сразу). Не задано, пусто, не число, отрицательное или бесконечное — значение по умолчанию (600); дробное округляется вниз |
