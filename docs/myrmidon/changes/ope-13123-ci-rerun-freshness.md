## changelog-en

### Fresh CI results after GitHub job reruns (OPE-13123)
GitHub `check_run`, `check_suite`, and `workflow_run` deliveries now invalidate the affected pull request head's CI snapshots. Run-context reads revalidate completed results through the existing conditional check-runs request, so a rerun can change FAILURE to SUCCESS without waiting for the old aggregate TTL. Unchanged UI reads retain the existing completed-result cache behavior.

## changelog-ru

### Актуальный итог CI после повторного запуска GitHub job (OPE-13123)
События GitHub `check_run`, `check_suite` и `workflow_run` теперь инвалидируют CI-снимки затронутого head pull request. Чтение контекста запуска повторно проверяет завершённый результат через существующий условный запрос check-runs, поэтому повторный запуск может изменить FAILURE на SUCCESS без ожидания старого TTL агрегата. Неизменившиеся UI-чтения сохраняют прежний кэш завершённого результата.
