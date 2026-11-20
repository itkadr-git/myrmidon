## changelog-en

### Host GC frees the worktree copies of reviewer bots after the review, in any task status

A reviewer bot makes a full worktree (about 0.5 GB) for each pull request it reviews, about one every
3 minutes per reviewer. On 16.11 the bots volume lost 11 GB in 6 minutes. The idle-clone rule of the host
clone GC (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) frees a copy only in `in_review`, `blocked` or
`backlog` and only after 6 hours. After the review the task goes to an engineer or to `done`, so the
reviewer's copy stayed on the disk.

The GC now has a separate rule for the copies of reviewer bots. It frees a copy in any task status when all of
these are true: the board shows no live run of this reviewer on the task; nothing in the copy changed for 10
minutes (`REVIEW_CLONE_IDLE_MINUTES`); `git status --porcelain` is empty (untracked service directories such
as `node_modules` do not count); and `HEAD` is on a branch that the server advertises. A run of another agent
on the same task, for example the engineer's `executionRunId`, does not keep the copy: the GC reads the owner of
each live run (`GET /heartbeat-runs/<id>`, field `agentId`). If the owner cannot be read, the copy is kept. The
GC finds the bot's agent on the board by the bot folder name (agent id or name). A reviewer is an agent with
the role `reviewer` or with `-review-` in its name, because the board has no reviewer role. The GC checks
the board again just before the removal.

The journal has `review-clone-removed` and `review-clone-kept` (with the reason). `--dry-run` shows the copies
in `plan.reviewClones` and as `review-clone-would-remove`. Copies of engineers are not changed.

## changelog-ru

### Уборка хоста освобождает рабочие копии ботов-ревьюеров после ревью при любом статусе задачи

Бот-ревьюер делает полную рабочую копию (git worktree, около 0,5 ГБ) на каждый PR, который ревьюирует, — примерно
раз в 3 минуты на ревьюера. 16.11 том ботов за 6 минут потерял 11 ГБ. Правило простоя уборки хоста
(`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) освобождает копию только в статусах `in_review`, `blocked`
и `backlog` и только через 6 часов. После ревью задача уходит к инженеру или в `done`, и копия ревьюера оставалась
на диске.

У уборки появилось отдельное правило для копий ботов-ревьюеров. Копия освобождается при любом статусе задачи,
если выполнено всё: на доске нет живого прогона этого ревьюера по задаче; в копии ничего не менялось 10 минут
(`REVIEW_CLONE_IDLE_MINUTES`); `git status --porcelain` пуст (неотслеживаемые служебные каталоги вроде
`node_modules` не считаются); `HEAD` лежит на ветке, которую объявляет сервер. Прогон другого агента по той же
задаче, например инженера (`executionRunId`), копию не удерживает: уборка читает владельца каждого живого
прогона (`GET /heartbeat-runs/<id>`, поле `agentId`). Если владельца прочитать нельзя, копия остаётся.
Агента бота уборка находит на доске по имени папки бота (id или имя агента). Ревьюер — агент с ролью `reviewer`
или с `-review-` в имени, так как роли ревьюера на доске нет. Прямо перед удалением доска опрашивается ещё раз.

В журнале — `review-clone-removed` и `review-clone-kept` (с причиной). `--dry-run` показывает копии в
`plan.reviewClones` и записью `review-clone-would-remove`. Копии инженеров не меняются.
