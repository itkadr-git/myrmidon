## changelog-en

### INTAKE-DIALOG: built-in analyst caste and no-code tool permissions (OPE-13020)

- Added built-in caste `analyst` with descriptive role guidance, `builtIn: true`, and `swarmEligible: false`.
- Defined `ANALYST_TOOL_PERMISSIONS` restricting analyst tools to task, document, and interaction management (`paperclip-self:*`) while preventing code and command execution (`terminal`, `execute_code`, `bash`, `patch`).
- Added integration tests verifying caste seeding (14 built-in castes) and tool gateway access enforcement with audit journaling.

## changelog-ru

### INTAKE-DIALOG: встроенная каста аналитика и права без выполнения кода (OPE-13020)

- Добавлена встроенная каста `analyst` с описанием роли, `builtIn: true` и `swarmEligible: false`.
- Определена константа `ANALYST_TOOL_PERMISSIONS`, разрешающая операции над задачами, документами и взаимодействиями (`paperclip-self:*`), и запрещающая запуск и исполнение кода (`terminal`, `execute_code`, `bash`, `patch`).
- Добавлены тесты сидирования каталога каст (14 встроенных каст) и проверки ограничений прав в tool gateway с аудитом отказа.
