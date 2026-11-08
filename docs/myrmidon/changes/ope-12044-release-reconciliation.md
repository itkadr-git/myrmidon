---
divergence-section: Трек 5 — эксплуатация
settings-section: 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)
---

## changelog-en

### Release reconciliation service and tests (1.7 STACK-UPDATES-B, OPE-12044)

- Added standalone release reconciliation module under `server/src/myrmidon/release-reconciliation/`
  with config reader, mockable GitHub client, in-memory issue sink, and reconciliation service.
- Normalises release and vendor tag versions (stripping `v`/`V`, `myr-v`, and image prefixes),
  detects divergences, and generates structured draft tasks with change summaries.
- Configurable via environment variables: `MYRMIDON_VENDOR_GITHUB_REPO`, `MYRMIDON_GITHUB_API_BASE`,
  `MYRMIDON_VENDOR_TAG`, `MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC`, and `MYRMIDON_RELEASE_TASK_COMPANY_ID`.

## changelog-ru

### Сервис сверки релизов и модульные тесты (1.7 STACK-UPDATES-B, OPE-12044)

- Добавлен отдельный модуль сверки релизов в `server/src/myrmidon/release-reconciliation/`
  с чтением настроек, мокируемым GitHub-клиентом, in-memory приемником задач и сервисом сверки.
- Нормализует версии релизов и тегов вендора (отсекая префиксы `v`/`V`, `myr-v` и образы),
  фиксирует расхождения и формирует структурированные черновики задач со сводкой изменений.
- Настраивается переменными окружения: `MYRMIDON_VENDOR_GITHUB_REPO`, `MYRMIDON_GITHUB_API_BASE`,
  `MYRMIDON_VENDOR_TAG`, `MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC` и `MYRMIDON_RELEASE_TASK_COMPANY_ID`.

## divergence

| OPE-12044 | Модуль периодической сверки релизов доски с последним тегом вендора GitHub и формирование черновика задачи при расхождении | server/src/myrmidon/release-reconciliation/** | STACK-UPDATES-B (1.7): информирование о выходе новых версий вендорского стека без блокировки работы | server/src/myrmidon/release-reconciliation/release-reconciliation.myrmidon.test.ts | Часть общей поставки STACK-UPDATES-B; удаляется при замене вендорским решением | (этот PR) |

## settings-en

| `MYRMIDON_VENDOR_GITHUB_REPO` | 1.7-STACK-UPDATES-B | `paperclipai/paperclip` | Vendor repository (`owner/repo`) checked for upstream release tags | Checked during periodic release reconciliation |
| `MYRMIDON_GITHUB_API_BASE` | 1.7-STACK-UPDATES-B | `https://api.github.com` | Base URL for the GitHub REST API | Overridden for GitHub Enterprise or mock API endpoints |
| `MYRMIDON_VENDOR_TAG` | 1.7-STACK-UPDATES-B | unset | Explicit vendor tag override for testing or manual divergence verification | When set, the reconciliation service skips GitHub network requests and assumes this vendor tag |
| `MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC` | 1.7-STACK-UPDATES-B | `86400` | Periodic release reconciliation interval in seconds (default: 24 hours) | Must be a positive integer |
| `MYRMIDON_RELEASE_TASK_COMPANY_ID` | 1.7-STACK-UPDATES-B | unset | Target company ID for auto-created release divergence draft tasks | When unset, falls back to the active company context |

## settings-ru

| `MYRMIDON_VENDOR_GITHUB_REPO` | 1.7-STACK-UPDATES-B | `paperclipai/paperclip` | Репозиторий вендора (`owner/repo`), опрашиваемый на наличие релизных тегов | Опрашивается во время периодической сверки релизов |
| `MYRMIDON_GITHUB_API_BASE` | 1.7-STACK-UPDATES-B | `https://api.github.com` | Базовый URL GitHub REST API | Переопределяется для GitHub Enterprise или мок-сервера API |
| `MYRMIDON_VENDOR_TAG` | 1.7-STACK-UPDATES-B | не задана | Явное переопределение тега вендора для тестов или ручной сверки | При установке сверка пропускает сетевые запросы к GitHub API и использует этот тег |
| `MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC` | 1.7-STACK-UPDATES-B | `86400` | Интервал периодической сверки релизов в секундах (по умолчанию 24 часа) | Должен быть положительным целым числом |
| `MYRMIDON_RELEASE_TASK_COMPANY_ID` | 1.7-STACK-UPDATES-B | не задана | Идентификатор компании, в которой создается черновик задачи при расхождении | Если не задан, используется контекст текущей компании |
