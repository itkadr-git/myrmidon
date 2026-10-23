## changelog-en

### `myr-ws`: one task can hold copies of two repositories (OPE-8946)

- `myr-ws open KEY owner/repo` no longer fails with "already open for ..." when the task already
  holds a copy of another repository: the second copy is opened next to the first as
  `/workspace/KEY.<repo-name>` (branch `bot/KEY` in its own base). Opening the same repository
  again returns its copy (`reused`).
- `myr-ws close KEY` closes every copy of the task (the first dirty or unpushed copy stops it
  with exit 7 as before); `myr-ws close KEY owner/repo` closes one. `myr-ws restore KEY owner/repo`
  picks the archive of that repository; `list` already shows every copy.

## changelog-ru

### `myr-ws`: одна задача может держать копии двух репозиториев (OPE-8946)

- `myr-ws open KEY owner/repo` больше не падает с «already open for ...», если у задачи уже
  есть копия другого репозитория: вторая копия открывается рядом с первой как
  `/workspace/KEY.<имя-репозитория>` (ветка `bot/KEY` в своей базе). Повторный `open` того же
  репозитория возвращает его копию (`reused`).
- `myr-ws close KEY` закрывает все копии задачи (первая грязная или не отправленная копия
  останавливает закрытие с кодом 7, как раньше); `myr-ws close KEY owner/repo` закрывает одну.
  `myr-ws restore KEY owner/repo` берёт архив этого репозитория; `list` и так показывает все копии.
