## changelog-en

### Quarantine ownership on issue creation (QUARANTINE-OWNERSHIP)

- Resolve and persist the responsible promotion owner for low-trust issue and child creation. Require an owner only when agent output is actually quarantined; ordinary agent-created issues remain unaffected. Bulk child creation validates ownership before persistence.

## changelog-ru

### Владелец карантина при создании задач (QUARANTINE-OWNERSHIP)

- При создании задач и дочерних задач из low-trust вывода определяется и сохраняется ответственный за promotion. Владелец обязателен только при фактической изоляции agent-вывода; обычное создание задач агентом не меняется. Пакетное создание проверяет владельца до записи данных.
