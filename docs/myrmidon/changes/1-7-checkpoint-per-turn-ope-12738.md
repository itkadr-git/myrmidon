## changelog-en

### Turn checkpoints of the working worktree (1.7 CHECKPOINT-PER-TURN, OPE-12738)

- Every completed agent turn of a run leaves a snapshot of the working
  execution-workspace tree as a hidden git ref
  `refs/myrmidon/turns/<runId>/<turnN>` on the run's worktree. Retention keeps
  the newest 10 refs per run; older ones are pruned oldest-first. The refs are
  hidden plumbing: plain `git log`/`git branch` do not show them and they are
  never pushed to remotes. Snapshotting is fail-open and never fails a run.
- New endpoints on the execution workspace: `GET .../turn-checkpoints?runId=`
  (list), `GET .../turn-checkpoints/diff?runId=&fromTurn=&toTurn=` (turn→turn
  introspection diff), and board-only `POST .../turn-checkpoints/restore`
  (`runtime:manage`). Restore rewinds the tracked working files and the index
  to the checkpoint tree; untracked files and the checked-out branch stay
  untouched.
- Restore refuses before it mutates: with 409 `worktree_busy_by_active_run`
  when another active run (`queued`/`running`) claims the worktree, and with
  409 `worktree_has_uncommitted_edits` when uncommitted tracked state (the
  worktree or the staged index) differs from the target checkpoint — a
  foreign staged edit survives even when the worktree file was rewritten back
  to the checkpoint content. Missing target ref is 404
  `turn_checkpoint_missing`. The write is audited as
  `execution_workspace.turn_checkpoint_restored`.
- Docs: operator guide
  `docs/myrmidon/guides/workspace-turn-checkpoints.md`
  (RU: `workspace-turn-checkpoints.ru.md`),
  wiki pages `Workspace-turn-checkpoints` (+ RU), links from
  `docs/architecture/execution-workspaces.md`
  and the guide tables.

## changelog-ru

### Чекпоинты turn'ов рабочего worktree (1.7 CHECKPOINT-PER-TURN, OPE-12738)

- Каждый завершённый turn прогона оставляет снимок рабочего дерева
  execution-workspace в виде скрытого git-ref
  `refs/myrmidon/turns/<runId>/<turnN>` на worktree прогона. Удержание хранит
  последние 10 refs на прогон; старые удаляются от старейших. Refs — скрытая
  внутренняя механика: обычные `git log`/`git branch` их не показывают, в
  remote они не пушатся. Снимок — fail-open и никогда не роняет прогон.
- Новые эндпоинты execution workspace: `GET .../turn-checkpoints?runId=`
  (список), `GET .../turn-checkpoints/diff?runId=&fromTurn=&toTurn=`
  (интроспекция диффа turn→turn) и `POST .../turn-checkpoints/restore`
  (только доска, `runtime:manage`). Restore откатывает отслеживаемые рабочие
  файлы и индекс к дереву чекпоинта; неотслеживаемые файлы и текущая ветка
  не затрагиваются.
- Restore отказывает до мутаций: с 409 `worktree_busy_by_active_run`, когда
  тот же worktree занимает другой активный прогон (`queued`/`running`), и с
  409 `worktree_has_uncommitted_edits`, когда незакоммиченное отслеживаемое
  состояние (worktree или staged-индекс) отличается от целевого чекпоинта —
  чужая staged-правка выживает, даже если файл в worktree переписали назад к
  содержимому чекпоинта. Отсутствующий целевой ref — 404
  `turn_checkpoint_missing`. Мутация аудируется как
  `execution_workspace.turn_checkpoint_restored`.
- Документация: руководство оператора
  `docs/myrmidon/guides/workspace-turn-checkpoints.ru.md`
  (EN: `workspace-turn-checkpoints.md`), страницы wiki
  `Workspace-turn-checkpoints.ru` (+ EN), ссылки из
  `docs/architecture/execution-workspaces.ru.md` и навигационных таблиц.
