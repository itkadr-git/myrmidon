## changelog-en

### Task list orders by a stored last-activity column (DB-PERF-P7)

- `GET /issues` and the blocked-inbox list no longer recompute the "last activity" of every
  candidate task with two correlated `MAX` subqueries (`issue_comments`, `activity_log`) before
  the `LIMIT` — that per-row aggregate was the endpoint's dominant cost. The value is now
  stored in `issues.last_activity_at` and indexed by `(company_id, last_activity_at)`.
- The stored value is `greatest(updated_at, newest comment, newest activity row)` per company,
  exactly as before; local inbox bookkeeping (`issue.read_marked`, `issue.read_unmarked`,
  `issue.inbox_archived`, `issue.inbox_unarchived`) still does not count as activity.
- The column is maintained by triggers, not by call sites: a new comment or activity row raises
  it, an issue update that moves `updated_at` raises it, and it never moves backwards.
- Migration `0307_issues_last_activity_at` is additive (new column with a default, new index,
  triggers); the previous image keeps working on the new schema. Existing rows are backfilled
  with the expression the endpoint used before.

## changelog-ru

### Список задач сортируется по хранимой колонке последней активности (DB-PERF-P7)

- `GET /issues` и список заблокированного инбокса больше не пересчитывают «последнюю
  активность» каждой подходящей задачи двумя коррелированными `MAX`-подзапросами
  (`issue_comments`, `activity_log`) до применения `LIMIT` — этот построчный агрегат и был
  основной ценой ручки. Значение теперь хранится в `issues.last_activity_at` и покрыто
  индексом `(company_id, last_activity_at)`.
- Хранимое значение — по-прежнему `greatest(updated_at, свежий комментарий, свежая запись
  журнала)` в границах компании; локальная работа с инбоксом (`issue.read_marked`,
  `issue.read_unmarked`, `issue.inbox_archived`, `issue.inbox_unarchived`) активностью не
  считается.
- Колонку ведут триггеры, а не места вызова: новый комментарий или запись журнала её
  поднимают, обновление задачи, двигающее `updated_at`, тоже, назад она не идёт.
- Миграция `0307_issues_last_activity_at` аддитивна (новая колонка со значением по умолчанию,
  новый индекс, триггеры); предыдущий образ продолжает работать на новой схеме. Существующие
  строки заполняются выражением, которым ручка пользовалась раньше.
## divergence-new

### 1.6.5 — DB-PERF C: last_activity_at в issues вместо коррелированных MAX

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| DB-PERF-P7 | Последняя активность задачи — `greatest(updated_at, свежий комментарий, свежая запись activity_log вне локальных inbox-действий)` — денормализована в `issues.last_activity_at`. Список задач и список заблокированного инбокса сортируются и отвечают по этой колонке: коррелированные `MAX`-подзапросы по `issue_comments`/`activity_log` и вспомогательная агрегатная выборка страницы (`lastActivityStatsForIssues`) удалены, контракт ответа не изменился. Значение ведут триггеры миграции 0307: INSERT комментария и `activity_log`, BEFORE INSERT/UPDATE на `issues`; backfill существующих строк — тем же выражением, что считала ручка. Единственное отличие от старого выражения: значение монотонно (удаление комментария или записи журнала его не понижает) | Вендор помечен `myrmidon(DB-PERF-P7)`: `packages/db/src/schema/issues.ts` (поле `lastActivityAt` и индекс `issues_company_last_activity_at_idx`), `server/src/services/issues.ts` (`issueCanonicalLastActivityAtExpr` читает колонку, `issueListSelect` отдаёт `lastActivityAt`, удалены `issueLatestCommentAtExpr`, `issueLatestLogAtExpr`, `latestIssueActivityAt`, `lastActivityStatsForIssues`); наши файлы: `packages/db/src/migrations/0307_issues_last_activity_at.sql` (+ `meta/0307_snapshot.json` и запись в `meta/_journal.json`), `packages/db/src/issues-last-activity-at.myrmidon.test.ts` | `GET /issues` в среднем 2,8 с: агрегат считался для всех ~4 тыс. задач до `LIMIT`. Цель части P7 — ручка < 300 мс | `packages/db/src/issues-last-activity-at.myrmidon.test.ts` (backfill против GREATEST-выражения, комментарий / запись журнала / рост `updated_at` поднимают колонку, локальные inbox-действия и записи о других типах сущностей — нет, план сортировки по индексу без SubPlan, порядок сортировки совпадает со старым выражением) | Никогда, наше поведение. Снятие: убрать колонку, индекс и триггеры, вернуть выражения в `server/src/services/issues.ts` | (этот PR) |
