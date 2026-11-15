# Чекпоинты turn'ов рабочего worktree

> English version: [workspace-turn-checkpoints.md](workspace-turn-checkpoints.md)

Каждый завершённый turn агента в прогоне оставляет снимок рабочего дерева
execution-workspace на git-worktree этого прогона. Снимок — скрытый git-ref
`refs/myrmidon/turns/<runId>/<turnN>`. Если прогон умер посреди turn'а,
оператор откатывает worktree к чекпоинту предыдущего turn'а и перезапускает
turn с него — повторный turn даёт идентичный дифф, а не наслаивается на
полуготовые правки (OPE-12738, выпуск 1.7 CHECKPOINT-PER-TURN).

Состояние живёт только в git: миграции схемы нет, refs — скрытая внутренняя
механика: обычные `git log`/`git branch` их не показывают, в remote они не
пушатся.

## Имена refs и удержание (retention)

- Refs лежат на worktree прогона под
  `refs/myrmidon/turns/<runId>/<turnN>`, где `<runId>` — id прогона побудки,
  `<turnN>` — монотонный номер turn'а внутри прогона с 1. Номера выводятся из
  существующих refs этого прогона (максимум + 1), поэтому остаются
  монотонными даже при перезапуске сессии провайдера посреди прогона.
- Снимок коммитит дерево, прочитанное из worktree (через временный индекс,
  чтобы не тронуть идущую git-операцию в живом worktree), связанное `-p` с
  чекпоинтом предыдущего turn'а того же прогона. Снимок фиксирует worktree
  как он есть; ветка и HEAD не двигаются.
- Удержание хранит последние 10 refs на прогон
  (`DEFAULT_TURN_CHECKPOINT_RETENTION`; пока не настраивается через
  окружение). При снимке turn'а N+1 refs сверх лимита удаляются, от старых
  к новым (`update-ref -d`), поэтому длинный прогон не растит репозиторий
  бесконечно.
- Каждый завершённый turn также пишет в лог прогона строку
  `paperclip.turn_checkpoint.created` с `runId` и `turnNumber`.

Снимок — fail-open: не-git worktree или разовый сбой git только пишет
предупреждение в лог и никогда не роняет прогон.

## Эндпоинты

Все три маршрута смонтированы по execution workspace. Чтение требует
`company_scope:read` на компанию workspace (член доски этой компании или ключ
агента той же компании); restore — действие уровня управления рантаймом:
только доска плюс `runtime:manage`. Ключ агента отклоняется с `403`.

Ошибки несут стабильный `code`: `turn_checkpoint_missing` (404),
`worktree_busy_by_active_run` (409), `worktree_has_uncommitted_edits` (409),
`worktree_missing` и `not_a_git_worktree` (422).

### GET /api/execution-workspaces/:id/turn-checkpoints?runId=

Список чекпоинт-refs одного прогона по порядку turn'ов. Каждая запись несёт
`runId`, `turnNumber`, `ref` и `commitSha`. `runId` обязателен.

### GET /api/execution-workspaces/:id/turn-checkpoints/diff?runId=&fromTurn=&toTurn=

Интроспекция: дифф turn→turn между двумя чекпоинтами одного прогона. Ответ:
`runId`, `fromTurn`, `toTurn`, `fromCommitSha`, `toCommitSha`, `stat`
(`git diff --stat`), `patch` и `truncated`. Патч ограничен 512 КиБ; больший
обрезается и помечается `truncated: true`. `fromTurn` и `toTurn` — целые ≥ 0;
отсутствующий ref на любой стороне — `404 turn_checkpoint_missing`.

### POST /api/execution-workspaces/:id/turn-checkpoints/restore

Тело: `{ "runId": "...", "targetTurnNumber": 3 }` (`reason` необязателен и
попадает только в журнал действий). Откатывает отслеживаемые рабочие файлы
**и индекс** worktree к дереву целевого чекпоинта (`git read-tree --reset -u
<commitSha>`). Неотслеживаемые файлы сохраняются, ветка не двигается. При
успехе ответ повторяет `runId`, `targetTurnNumber`, `ref`, `commitSha` и
`refBefore` (символическая ветка до отката, когда HEAD был на ветке).

Запись аудируется как действие `execution_workspace.turn_checkpoint_restored`
с прогоном, turn'ом, ref, коммитом и исходной задачей workspace.

## Порядок проверок при restore

Restore отказывает до всякого изменения. Проверки идут в этом порядке,
первая же неудача прерывает операцию без мутаций:

1. Worktree существует и это git-worktree (`worktree_missing` /
   `not_a_git_worktree`).
2. **Занятость чужим активным прогоном** (`worktree_busy_by_active_run`,
   409): тот же worktree занимает другой активный прогон (`queued` или
   `running`) — из другого execution workspace или другой прогон того же
   workspace в режиме общего workspace. Откат под живой прогон ломает его
   состояние; сначала остановите тот прогон или дождитесь его завершения.
3. Целевой ref разрешается (`turn_checkpoint_missing`, 404).
4. **Безопасность незакоммиченного состояния**
   (`worktree_has_uncommitted_edits`, 409): незакоммиченное отслеживаемое
   состояние должно совпадать с целевым чекпоинтом по *обеим* сторонам —
   worktree (`git diff <commitSha>`) и индекс
   (`git diff --cached <commitSha>`). Расхождение хоть на одной стороне
   отказывает в restore и перечисляет первые 20 путей в `details.paths`. Это
   защищает чужую staged-правку даже когда файл в worktree переписали назад
   к содержимому чекпоинта: `read-tree --reset -u` сбрасывает и индекс, и
   сравнение только по worktree молча уничтожило бы такой staged-контент.

Только когда все проверки пройдены, restore выполняет `read-tree --reset -u`.
Закоммиченная история между HEAD и целью защиты не требует: она остаётся
достижимой с HEAD, и откат её — ровно то, для чего restore существует.

## Типовое восстановление

Прогон умер посреди turn'а N. Чтобы перезапустить turn N с состояния
предыдущего turn'а:

1. `GET .../turn-checkpoints?runId=...` — найдите последний завершённый
   turn (N-1) и его `commitSha`.
2. Убедитесь, что на worktree нет другого активного прогона (иначе ждите
   409 `worktree_busy_by_active_run`).
3. `POST .../turn-checkpoints/restore` с телом
   `{"runId": "...", "targetTurnNumber": N-1}`.
4. Перезапустите turn; `GET .../turn-checkpoints/diff?...&fromTurn=N-1&toTurn=N`
   покажет, что изменил повторный turn.
