---
divergence-section: 1.7 — LOCALE-UPLOAD: загрузка файла каталога локализации через API + валидация ключей
settings-section: 1.7 — LOCALE-UPLOAD: Custom Localization Catalogs (`customLocales`)
---

## divergence

| 1.7 LOCALE-UPLOAD | Вендорский серверный API загрузки пользовательских каталогов локализации, валидация структуры, ключей, плейсхолдеров и опасного содержимого, хранение и версионирование каталогов | `server/src/myrmidon/locale-upload/`, `server/src/app.ts`, `packages/shared/src/locale-upload.ts` | Серверу нужен единый API для безопасного приёма собственных переводов владельца | `server/src/myrmidon/locale-upload/locale-upload.myrmidon.test.ts` | Удалить locale-upload routes/service/validator/tests/reference, shared schema/export, app registration, settings preservation and guides | OPE-8650 |

## settings-en

| `instance_settings.general.customLocales` | OPE-8650 | `{}` | Stored custom localization catalogs uploaded by board members, keyed by locale identifier. Preserved across instance settings updates without restarting the server. | Delete custom locale upload implementation and remove the setting preservation hook. |

## settings-ru

| `instance_settings.general.customLocales` | OPE-8650 | `{}` | Сохранённые пользовательские каталоги локализации, загруженные участниками совета и индексированные по идентификатору локали. Сохраняются при обновлении настроек инстанса без перезапуска сервера. | Удалить реализацию загрузки каталогов и хук сохранения настройки. |
