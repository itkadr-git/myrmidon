## changelog-en

### DEVFLOW: return in_review task to PR author on merge conflict (#OPE-9976)

- When an open PR of an `in_review` task has `mergeable=CONFLICTING`, task is returned to the PR author in `in_progress` status with a conflict comment.

## changelog-ru

### DEVFLOW: возврат задачи автору PR при конфликте слияния (#OPE-9976)

- При `mergeable=CONFLICTING` у открытого PR задачи в статусе `in_review` задача возвращается автору PR в `in_progress` с комментарием о конфликте слияния.
