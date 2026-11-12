## changelog-en

### OPE-12780: immediate no_reviewer signal restricts reviewer availability to the issue's own agent group

- The immediate `no_reviewer` availability pre-check in `server/src/routes/issues.ts` now filters reviewers through `ownGroupReviewerPool` keyed on the issue anchor's group, so an empty own team signals instead of staying silent because another team's reviewer has capacity.
- Added a route regression test proving that an out-of-group reviewer does not suppress the `no_reviewer` signal.

## changelog-ru

### OPE-12780: немедленный сигнал no_reviewer ограничивает доступность ревьюеров группой задачи

- Проверка доступности для немедленного сигнала `no_reviewer` в `server/src/routes/issues.ts` теперь фильтрует ревьюеров через `ownGroupReviewerPool` по группе якорного агента задачи: пустой пул своей группы выдаёт сигнал, даже если у чужой команды есть свободный ревьюер.
- Добавлен регрессионный тест маршрута, подтверждающий, что чужой ревьюер не подавляет сигнал `no_reviewer`.
