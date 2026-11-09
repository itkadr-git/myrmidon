## changelog-en

### Fixed: typed review resubmit after changes_requested no longer fails recovery-path validation (OPE-9733)

- Resubmitting an issue to `in_review` after a `changes_requested` review stage no longer returns `422 missing review_path`. When a review/approval stage is configured, the executor resubmitting from the recovery-action route now lands back in `in_review` with the reviewer continuation preserved: the same review stage, `returnAssignee` stays with the original executor, and no recovery loop.
- Two fixes in `server/src/routes/issues.ts` (PR #1966, merge `ddc27433`): the review-path validator now falls back to `input.existing.executionPolicy` when the resubmit PATCH carries no `executionPolicy` field, and in `POST /api/issues/:id/recovery-actions/resolve` the execution-policy transition is applied before `assertInReviewReviewPath` so the validator sees the typed reviewer continuation in the update fields.
- Covered by regression tests: recovery route (`server/src/__tests__/issue-recovery-actions.test.ts`), issue PATCH route (`server/src/__tests__/issue-execution-policy-routes.test.ts`).

## changelog-ru

### Исправлено: повторная сдача на ревью после changes_requested больше не падает с missing review_path (OPE-9733)

- Повторная сдача задачи в `in_review` после `changes_requested` на этапе ревью больше не отвечает `422 missing review_path`. Когда этап ревью/приёмки настроен, исполнитель, сдающий работу повторно через маршрут recovery-action, снова попадает в `in_review` с сохранённым продолжением ревью: тот же этап ревью, `returnAssignee` остаётся у исходного исполнителя, цикла recovery нет.
- Две правки в `server/src/routes/issues.ts` (PR #1966, merge `ddc27433`): валидатор пути ревью теперь подставляет `input.existing.executionPolicy`, если повторный PATCH не несёт поля `executionPolicy`, а в `POST /api/issues/:id/recovery-actions/resolve` переход по execution policy применяется до `assertInReviewReviewPath`, так что валидатор видит типизированное продолжение ревьюера в update fields.
- Покрыто регрессионными тестами: recovery-маршрут (`server/src/__tests__/issue-recovery-actions.test.ts`) и PATCH-маршрут задачи (`server/src/__tests__/issue-execution-policy-routes.test.ts`).
