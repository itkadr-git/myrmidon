# Чекпоинты turn'ов рабочих областей

> English version: [Workspace-turn-checkpoints](Workspace-turn-checkpoints)

Каждый завершённый turn агента в прогоне оставляет снимок рабочего дерева
execution-workspace на git-worktree этого прогона. Снимок — скрытый git-ref
`refs/myrmidon/turns/<runId>/<turnN>`. Если прогон умер посреди turn'а,
оператор откатывает worktree к чекпоинту предыдущего turn'а и перезапускает
turn с него — повторный turn даёт идентичный дифф, а не наслаивается на
полуготовые правки (OPE-12738, выпуск 1.7).

Состояние живёт только в git — миграции схемы нет; обычные
`git log`/`git branch` refs не показывают, в remote они не пушатся.

## Имена refs и удержание

- Refs лежат на worktree прогона под `refs/myrmidon/turns/<runId>/<turnN>`;
  номера turn'ов — внутри прогона, монотонные с 1 (максимум существующих + 1),
  поэтому переживают перезапуск сессии провайдера посреди прогона.
- Снимок читает worktree через временный индекс (идущая git-операция в живом
  worktree не повреждается) и связывается `-p` с чекпоинтом предыдущего
  turn'а того же прогона. Ветка и HEAD не двигаются.
- Удержание хранит последние 10 refs на прогон; refs сверх лимита удаляются
  от старых к новым при снимке следующего turn'а.
- Каждый завершённый turn пишет в лог строку `paperclip.turn_checkpoint.created`
  с `runId` и `turnNumber`. Снимок — fail-open и никогда не роняет прогон.

## Эндпоинты

Маршруты смонтированы по execution workspace. Чтение требует
`company_scope:read` на компанию; restore — только доска плюс
`runtime:manage` (ключ агента получает `403`). Ошибки несут стабильный
`code`: `turn_checkpoint_missing` (404), `worktree_busy_by_active_run` (409),
`worktree_has_uncommitted_edits` (409), `worktree_missing` /
`not_a_git_worktree` (422).

- `GET /api/execution-workspaces/:id/turn-checkpoints?runId=` — чекпоинты
  прогона по порядку turn'ов (`runId`, `turnNumber`, `ref`, `commitSha`).
- `GET /api/execution-workspaces/:id/turn-checkpoints/diff?runId=&fromTurn=&toTurn=`
  — дифф turn→turn: `stat`, `patch` (ограничен 512 КиБ, дальше
  `truncated: true`) и оба SHA коммитов.
- `POST /api/execution-workspaces/:id/turn-checkpoints/restore` с телом
  `{"runId": "...", "targetTurnNumber": N}` — откатывает отслеживаемые
  рабочие файлы **и индекс** к дереву чекпоинта (`git read-tree --reset -u`).
  Неотслеживаемые файлы выживают; ветка не двигается. Аудируется как
  `execution_workspace.turn_checkpoint_restored`.

## Порядок проверок при restore

Restore отказывает до всякого изменения:

1. Worktree существует и это git-worktree.
2. Никакой другой активный прогон (`queued`/`running`) не занимает worktree —
   иначе 409 `worktree_busy_by_active_run`. Сначала остановите тот прогон или
   дождитесь его завершения.
3. Целевой ref разрешается — иначе 404 `turn_checkpoint_missing`.
4. Незакоммиченное отслеживаемое состояние должно совпадать с целевым
   чекпоинтом по обеим сторонам: worktree (`git diff <commitSha>`) **и**
   индекс (`git diff --cached <commitSha>`). Расхождение хоть на одной
   стороне отказывает с 409 `worktree_has_uncommitted_edits` и перечисляет
   до 20 путей. Это защищает чужую staged-правку даже когда файл в worktree
   переписали назад к содержимому чекпоинта — `read-tree --reset -u` сбрасывает
   и индекс, и сравнение только по worktree молча уничтожило бы
   staged-контент.

Только после всех проверок restore выполняет `read-tree --reset -u`.

Полное руководство:
[workspace-turn-checkpoints.ru.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/workspace-turn-checkpoints.ru.md).
