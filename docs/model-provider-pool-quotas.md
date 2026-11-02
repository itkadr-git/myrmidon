# Pool quota telemetry / Телеметрия квот пулов

## English

The model-provider channels API reads account records from the configured pool connector's `GET /accounts` response. Numeric `limited_until` / `limitedUntil` is preserved as the account reset time (Unix seconds). If absent, the service searches the account error/message and recent error messages for Google text `Resets in <number> seconds|minutes|hours|days` and converts that duration to Unix seconds relative to the service clock. The account's latest error comes from the newest `usage.recent_errors` / `usage.recentErrors` entry by `at` (or `timestamp`), falling back to the connector's top-level `error`; values are bounded to 500 characters. Unknown payloads do not fabricate a reset.

Feature safety and rollout: adding these pool types does not edit account files, tokens, or perform login/migration. Keep connector/plugin registration disabled until ADM's rollout window. Then enable one account/provider at a time through the existing connector gate; issue a live model request, observe for 24 hours, and proceed only if healthy. Rollback is to disable that provider/account through the same gate; it does not require relogin or token replacement. Do not deploy or alter production account data from this change. ADM must compare all 55 Antigravity reset values against `agy-api.sh GET /accounts` after deployment before declaring acceptance.

## Русский

API каналов model-provider читает записи учётных записей из ответа `GET /accounts` настроенного коннектора пула. Числовое `limited_until` / `limitedUntil` сохраняется как время сброса учётки (Unix seconds). Если поля нет, сервис ищет в ошибке/сообщении учётки и сообщениях последних ошибок Google-текст `Resets in <число> seconds|minutes|hours|days` и переводит длительность в Unix seconds относительно часов сервиса. Последняя ошибка берётся из самой новой записи `usage.recent_errors` / `usage.recentErrors` по `at` (или `timestamp`), иначе используется верхнеуровневое `error` коннектора; длина ограничена 500 символами. Для неизвестного формата время сброса не выдумывается.

Безопасность и поэтапный выкат: добавление типов пулов не изменяет файлы учёток/токены и не выполняет вход или миграцию. Не включать регистрацию коннектора/плагина до окна выката ADM. Затем включать по одной учётке/провайдеру через существующий connector gate; выполнить живой запрос модели, наблюдать 24 часа и продолжать только при нормальной работе. Откат — выключить соответствующего провайдера/учётку тем же gate; повторный вход и замена токена не требуются. Этот код не выкатывается и не меняет production-данные самостоятельно. После выката ADM должен сверить сбросы всех 55 учёток Antigravity с `agy-api.sh GET /accounts` до подтверждения приёмки.

## Change log / Журнал изменений

- 2026-11-01 — Added reset-duration fallback parsing and latest-account-error mapping for pool channels, with a focused fixture test and staged enable/rollback guidance — OPE-10375, PR #2220.

## Sources / Источники

- OPE-10375, PR #2220; service mapping: `server/src/myrmidon/model-providers/service.ts`.
- Fixture coverage: `server/src/myrmidon/model-providers/quota-payload.test.ts`.
- Production truth check is intentionally pending ADM rollout: `agy-api.sh GET /accounts` versus all 55 displayed Antigravity accounts.
