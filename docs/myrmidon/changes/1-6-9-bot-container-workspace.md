---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## changelog-en

### Isolated task workspace of container agents lives on the bot disk, not on the board (OPE-13213)

For `hermes_gateway` and `omp_local`, an isolated run now uses the task directory of the bot (`/workspace/<ISSUE>`). The board creates no git worktree, no shared checkout, no clone and no project directory for it. The run is recorded as one `execution_workspaces` row per task with strategy `bot_container`. A board-side git worktree (local adapters) is refused with `WORKTREE_PARTITION_FULL` when the partition is at or above `general.botDisk.partitionRefuseOpenPercent`.

## changelog-ru

### Изолированная рабочая копия задачи агентов в контейнере живёт на диске ботов, а не на доске (OPE-13213)

Для `hermes_gateway` и `omp_local` изолированный прогон теперь использует каталог задачи бота (`/workspace/<ISSUE>`). Доска не создаёт для него ни git worktree, ни общего checkout, ни клона, ни каталога проекта. Прогон записывается одной строкой `execution_workspaces` на задачу со стратегией `bot_container`. Копия доски (git worktree, локальные адаптеры) не создаётся с отказом `WORKTREE_PARTITION_FULL`, если раздел заполнен не ниже `general.botDisk.partitionRefuseOpenPercent`.
