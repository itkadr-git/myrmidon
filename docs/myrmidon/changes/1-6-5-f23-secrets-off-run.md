---
divergence-section: Трек 6 — безопасность и модели
---

## changelog-en

### Off-run self-secret reads via a time-boxed `secrets:read_off_run` grant (F-23)

- New permission `secrets:read_off_run`. It is issued by board actors only (the
  agent card toggle, `PATCH /agents/:id/permissions` with `offRunSecretRead`, or the
  existing principal grants) and is always time-boxed: without an explicit
  deadline it expires 30 days out, and enabling it again renews the term to a
  fresh 30 days. An expired grant is denied centrally (`deny_expired_grant`).
- With an active grant, an agent acting without a run (operator CLI/session) may call
  `GET /api/agents/me/secrets` and gets the metadata of its own bound secrets, never
  values. Only an own agent key with the `standard` scope is admitted; automation and
  service keys are rejected. `GET /companies/:companyId/secrets` stays board-only.
  Without the grant the historical `403 "Run-bound agent authentication required"`
  is returned unchanged.
- Every off-run listing writes a `secret_access_events` row with
  `details = { offRun: true, access: "agent_self_metadata", keyId, remoteAddress,
  listedSecretCount }`; a failed audit write fails the request (500). `remoteAddress`
  is Express `req.ip` (honors `trust proxy`, by default the socket peer); a
  client-supplied `X-Forwarded-For` is never recorded.
- The attention feed gets two advisory items: `secret_off_run_reads` (reads in the
  last 24 hours) and `secret_off_run_grant_expiring` (a grant expires within 3 days).
- Migration `0382` adds `principal_permission_grants.expires_at` and
  `secret_access_events.details`. The agent card shows the grant state and expiry
  in the Permissions section; the full settings UI is deferred to 1.6.6.

## changelog-ru

### Чтение своих секретов агентом вне прогона по гранту `secrets:read_off_run` с ограниченным сроком (F-23)

- Новое право `secrets:read_off_run`. Выдаёт только board-актёр (переключатель в
  карточке агента, `PATCH /agents/:id/permissions` с `offRunSecretRead` или обычные
  гранты принципала), и срок у него всегда ограничен: без явного срока грант
  истекает через 30 дней, повторное включение продлевает срок ещё на 30 дней.
  Истёкший грант отклоняется централизованно (`deny_expired_grant`).
- При активном гранте агент без прогона (операторский CLI/сессия) может вызвать
  `GET /api/agents/me/secrets` и получает метаданные своих привязанных секретов,
  значения никогда. Допускается только собственный ключ агента со скоупом `standard`;
  ключи automation и service отклоняются. `GET /companies/:companyId/secrets`
  остаётся board-only. Без гранта возвращается прежний
  `403 "Run-bound agent authentication required"`.
- Каждое чтение вне прогона пишет строку `secret_access_events` с
  `details = { offRun: true, access: "agent_self_metadata", keyId, remoteAddress,
  listedSecretCount }`; сбой записи аудита роняет запрос (500). `remoteAddress` —
  `req.ip` Express (учитывает `trust proxy`, по умолчанию адрес сокета); присланный
  клиентом `X-Forwarded-For` в запись не попадает.
- В ленте внимания два справочных пункта: `secret_off_run_reads` (чтения за последние
  24 часа) и `secret_off_run_grant_expiring` (грант истекает в течение 3 дней).
- Миграция `0382` добавляет `principal_permission_grants.expires_at` и
  `secret_access_events.details`. Карточка агента показывает состояние гранта и срок
  в разделе «Разрешения»; полный интерфейс настроек отложен на 1.6.6.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.5-F23-SECRETS-OFF-RUN | Агент без прогона читает метаданные своих секретов (`GET /agents/me/secrets`) только при активном гранте `secrets:read_off_run`: выдаёт лишь board, срок по умолчанию 30 дней (`resolveGrantExpiresAt`), просроченный грант отклоняется в `decidePrincipalGrant` (`deny_expired_grant`), допускается только `agent_key` со скоупом `standard`, каждое чтение пишет `secret_access_events` с `details.offRun` и `remoteAddress` из `req.ip` (не из `X-Forwarded-For`), в ленте внимания пункты `secret_off_run_reads` и `secret_off_run_grant_expiring` | `server/src/routes/secrets.ts` (`agentSecretContextOffRun`), `server/src/routes/agents.ts` (флаг `offRunSecretRead`), `server/src/services/secrets.ts` (`listAgentSecretAccessOffRun`), `server/src/services/access.ts`, `server/src/services/authorization.ts`, `server/src/services/attention.ts`, `server/src/services/decision-queues.ts`, `packages/shared` (константа права, типы, валидатор), `packages/db` (миграция 0382, схемы `principal_permission_grants`/`secret_access_events`), `ui/src/pages/AgentDetail.tsx`, `ui/src/lib/attention.ts`; все точки помечены `myrmidon(1.6.5-F-23)` | Административному агенту нужно сверять привязки своих секретов из операторской сессии без прогона; у вендора маршрут требует run-bound токен. Компенсации: срок гранта, выдача только board, только свои секреты, аудит на каждое чтение, видимость в ленте внимания | `server/src/__tests__/secrets-routes.test.ts` (матрица грант × ключ × маршрут, подмена `X-Forwarded-For`), `server/src/__tests__/authorization-service.test.ts` (просроченный и будущий грант), `server/src/__tests__/secrets-service.test.ts` (запись аудита `offRun: true`) | Когда вендор сам допустит такое чтение: удалить `agentSecretContextOffRun`, право, пункты ленты и переключатель в карточке, оставить тесты на вендорском поведении; миграцию 0382 не откатывать | (этот PR) |
