## settings-en-append

<!-- after-line: - **Route:** `PATCH /api/myrmidon/behavior-settings/company/:companyId` (and legacy alias `PATCH /api/myrmidon/behavior-settings/:companyId`) -->

- **Access:** Board users with access to the company (`assertCompanyAccess`), or agent keys holding the `users:manage_permissions` company grant (`assertBoardOrAgentGrant`; since 1.6.8 an agent key without the grant receives `403 Forbidden`). Cross-company access receives `403 Forbidden`. Replaces the previous "Users with access to the specified company" line for the PATCH routes (OPE-12699).

## settings-ru-append

<!-- after-line: - **Маршрут:** `PATCH /api/myrmidon/behavior-settings/company/:companyId` (и легаси-алиас `PATCH /api/myrmidon/behavior-settings/:companyId`) -->

- **Права доступа:** Board-пользователи с доступом к компании (`assertCompanyAccess`), либо агентские ключи с грантом `users:manage_permissions` компании (`assertBoardOrAgentGrant`; с 1.6.8 агентский ключ без гранта получает `403 Forbidden`). Доступ к чужим компаниям отклоняется с `403 Forbidden`. Заменяет прежнюю строку «Доступ к целевой компании» для PATCH-маршрутов (OPE-12699).

## changelog-en

### Company behavior-settings writes need an explicit agent permission grant (1.6.8 BEHAVIOR-SETTINGS-AUTHZ, OPE-12699)

- `PATCH /api/myrmidon/behavior-settings/company/:companyId` (and the legacy alias `PATCH /api/myrmidon/behavior-settings/:companyId`) no longer accepts every agent key with company access. Board users keep writing as before; an agent key is admitted only with an explicit `users:manage_permissions` grant for that company, and receives `403 Forbidden` without one (no stored change, no audit entry).
- Grants are managed on `PATCH /api/companies/:companyId/members/:memberId/permissions` (the same key the tool-access routes use). The instance-level `PATCH`/`PUT /api/myrmidon/behavior-settings` stays instance-admin only, and company settings reads are unchanged.

## changelog-ru

### Запись настроек поведения компании требует явного агентского разрешения (1.6.8 BEHAVIOR-SETTINGS-AUTHZ, OPE-12699)

- `PATCH /api/myrmidon/behavior-settings/company/:companyId` (и легаси-алиас `PATCH /api/myrmidon/behavior-settings/:companyId`) больше не принимает любой агентский ключ с доступом к компании. Board-пользователи пишут как прежде; агентский ключ допускается только с явным грантом `users:manage_permissions` на эту компанию, а без него получает `403 Forbidden` (без записи в хранилище и без события аудита).
- Гранты выдаются через `PATCH /api/companies/:companyId/members/:memberId/permissions` (тот же ключ, что используют маршруты tool-access). Инстансовые `PATCH`/`PUT /api/myrmidon/behavior-settings` остаются только для администратора инстанса, чтение настроек компании не меняется.
