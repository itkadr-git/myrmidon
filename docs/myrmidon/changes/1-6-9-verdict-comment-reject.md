## changelog-en

### Review verdict comments rejected with guidance (1.6.9 OPE-13115)

- Reject comments starting with `APPROVE` or `REQUEST CHANGES` posted by the current review-stage participant on an `in_review` issue with HTTP 422 and actionable hint to use `PATCH /api/issues/<id>` instead.
- Prevents review stages from stalling silently when reviewer agents accidentally post their verdict as a plain comment.
- Normal comments from reviewers, non-verdict comments, and comments by operators or other agents remain unaffected.

## changelog-ru

### Отклонение вердикта ревью простым комментарием с подсказкой (1.6.9 OPE-13115)

- Добавлено отклонение комментариев с вердиктом (`APPROVE` или `REQUEST CHANGES`), отправленных текущим участником этапа ревью по задаче в `in_review` со статусом `pending`, с кодом 422 и подсказкой использовать `PATCH /api/issues/<id>`.
- Предотвращает зависание этапа ревью, когда агент-ревьюер отправляет вердикт через простой комментарий вместо смены статуса.
- Обычные комментарии ревьюера, комментарии оператора и комментарии других агентов остаются без изменений.
