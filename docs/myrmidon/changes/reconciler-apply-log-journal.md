## changelog-en

### Bot-container reconciler journal records identify the applied profile and trigger

- Apply records now include `appliedFilesHash` and, when set by the compiled profile, `appliedMaxConcurrentRuns`, alongside the existing `restartHash`.
- The `trigger` field records `<state>:<drift|nodrift>:<changeClass>` (for example, `running:nodrift:restart`); newly created containers use `missing:new`.
- Records for updates deferred by a maintenance window include `maintenanceReason` with the window's reason. These fields improve journal diagnostics only; reconciliation behavior is unchanged.

## changelog-ru

### Записи журнала реконсайлера бот-контейнеров указывают применённый профиль и причину

- В записи о применении теперь есть `appliedFilesHash` и, если скомпилированный профиль задаёт это значение, `appliedMaxConcurrentRuns`; рядом остаётся существующий `restartHash`.
- Поле `trigger` содержит `<state>:<drift|nodrift>:<changeClass>` (например, `running:nodrift:restart`); для вновь созданного контейнера используется `missing:new`.
- В записи об отложенном из-за окна обслуживания обновлении есть `maintenanceReason` со значением причины окна. Эти поля улучшают диагностику по журналу и не меняют поведение реконсайлера.
