---
divergence-section: 2.0 — i18n нового интерфейса (UI2-I18N)
---

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| LOCALE-UPLOAD | Линтер и валидатор структуры каталога локализации: чистое разделение валидации схемы, ограничений вложенности/размера, запрета опасных полезных нагрузок (<script, обработчики событий, опасные схемы URL), проверки синтаксиса и паритета плейсхолдеров, проверки отсутствующих/лишних ключей и расчета процента покрытия. Модули: `@myrmidon/shared` (`locale-validator.ts`), серверный API-маршрут `POST /api/myrmidon/locales/validate` (`server/src/myrmidon/locale-upload/routes.ts`), клиентский модуль `ui/src/ui2/i18n/catalog-validator.ts` и `api.ts`. | `packages/shared/src/index.ts`, `server/src/app.ts`, `ui/src/ui2/i18n/api.ts` (помечены `myrmidon(1.7 LOCALE-UPLOAD, OPE-10187)`); новые: `packages/shared/src/locale-validator.ts`, `packages/shared/src/locale-upload.ts`, `server/src/myrmidon/locale-upload/*`, `ui/src/ui2/i18n/catalog-validator.ts` | OPE-10187: валидация и линтинг структуры каталогов перед загрузкой | `packages/shared/src/locale-validator.test.ts`, `server/src/myrmidon/locale-upload/routes.myrmidon.test.ts`, `ui/src/ui2/i18n/catalog-validator.myrmidon.test.ts` | Никогда, наше поведение | (этот PR) |
