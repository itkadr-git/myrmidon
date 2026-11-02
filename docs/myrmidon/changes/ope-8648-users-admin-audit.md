## changelog-en

### User administration audit log and role management (OPE-8648)
- Added `GET /api/myrmidon/users-admin-a/audit` for user-management audit records with actor/target enrichment and filters by target user, actor, action, and limit.
- Added instance-admin/member role changes with `instance.user.role_changed` audit details and safeguards against self-demotion and demoting the last instance administrator.
- Added Users and Audit Log tabs to the Users administration screen, with role controls and audit filters.
- Added integration coverage for audit events, role management, filtering, and deduplication.

## changelog-ru

### Журнал аудита управления пользователями и управление ролями (OPE-8648)
- Добавлен `GET /api/myrmidon/users-admin-a/audit` для журнала действий с данными автора и цели и фильтрами по пользователю, автору, действию и лимиту.
- Добавлена смена ролей instance-admin/member с событием `instance.user.role_changed` и защитой от саморазжалования и разжалования последнего администратора.
- На экран управления пользователями добавлены вкладки пользователей и журнала аудита, управление ролями и фильтры.
- Добавлены интеграционные тесты аудита, ролей, фильтрации и дедупликации.
