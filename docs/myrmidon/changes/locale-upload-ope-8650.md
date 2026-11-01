## divergence-new

<!-- after: 1.6.5 — F-26 T10 SWARM-SCENT: запах задачи и агента, логика Jev -->

### 1.7 — LOCALE-UPLOAD: загрузка файла каталога локализации через API + валидация ключей

| 1.7-LOCALE-UPLOAD | Приём файла каталога локализации через API, валидация ключей против эталонного каталога en, отчёт об ошибках (пропущенные/лишние ключи, плейсхолдеры, XSS/script-пейлоады, синтаксис JSON), хранение в БД и версионирование. Новые маршруты: `POST /api/myrmidon/locales/upload` (JSON или multipart/form-data), `POST /api/myrmidon/locales/validate`, `GET /api/myrmidon/locales/custom`, `GET /api/myrmidon/locales/custom/:locale`, `DELETE /api/myrmidon/locales/custom/:locale`. Сохранение в `instance_settings.general.customLocales` с вычислением SHA-256 контрольной суммы и инкрементом версии каталога. | Наши файлы: `packages/shared/src/locale-upload.ts`, `server/src/myrmidon/locale-upload/index.ts`, `server/src/myrmidon/locale-upload/routes.ts`, `server/src/myrmidon/locale-upload/service.ts`, `server/src/myrmidon/locale-upload/settings.ts`, `server/src/myrmidon/locale-upload/validator.ts`, `server/src/myrmidon/locale-upload/en-reference.json`, `server/src/myrmidon/locale-upload/locale-upload.myrmidon.test.ts`; в вендоре помечены `myrmidon(1.7 LOCALE-UPLOAD, OPE-8650)`: `packages/shared/src/index.ts` (экспорт контракта), `server/src/app.ts` (монтирование роутера), `server/src/services/instance-settings.ts` (сохранение ключа `customLocales` при обновлении настроек general) | Эпик 1.7 LOCALE-UPLOAD (OPE-8650): серверная часть загрузки собственной локализации владельца, валидация структуры каталога и ключей перевода | `server/src/myrmidon/locale-upload/locale-upload.myrmidon.test.ts` (валидация JSON, дифференциальный отчёт ключей, проверка плейсхолдеров, защита от XSS, загрузка через multipart и JSON, строгий режим, обработка ошибок, CRUD custom-каталогов, версионирование v1/v2, валидация прав доступа board-only) | Никогда, наше поведение. Снятие: удалить модуль `locale-upload`, убрать маркеры `myrmidon(1.7 LOCALE-UPLOAD, OPE-8650)` | OPE-8650 |

## settings-en-append

<!-- section: 1.6.5 — SWARM: the board pairs tasks with free agents, no "look for work" wakes -->

### 1.7 LOCALE-UPLOAD: Custom Localization Catalogs (`customLocales`)
- **Key**: `instance_settings.general.customLocales`
- **Source**: API `POST /api/myrmidon/locales/upload` (and `DELETE /api/myrmidon/locales/custom/:locale`)
- **Description**: Stored custom localization catalogs uploaded by board members, keyed by locale identifier (`{ [locale]: StoredCustomLocale }`). Preserved across instance settings updates without restarting the server.
