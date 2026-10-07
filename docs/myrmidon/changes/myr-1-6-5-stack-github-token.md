---
settings-section: 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)
---

## changelog-en

### 1.6.5 STACK-UPDATES: optional GitHub token for the stack release check (OPE-5564)

- `MYRMIDON_STACK_GITHUB_TOKEN` (secret class): an optional read-only GitHub
  token (fine-grained PAT with public-repo read, no scopes needed) for the
  scheduled and manual stack release check. When set, every api.github.com
  request of the check (release/tag lists and the compare API — one shared
  JSON port) carries `authorization: Bearer <token>`.
- Anonymous behaviour is the default: unset or blank env → no authorization
  header, the 60 requests/hour per egress IP budget. A valid token lifts the
  budget to 5000 requests/hour.
- An invalid or revoked token is ordinary data: GitHub answers 401/403 and the
  status is recorded per component as an HTTP error, the previous cache is
  kept — exactly like any other HTTP status. The value is never logged and
  never returned by any route.

## changelog-ru

### 1.6.5 STACK-UPDATES: опциональный GitHub-токен для сверки релизов стека (OPE-5564)

- `MYRMIDON_STACK_GITHUB_TOKEN` (класс secret): опциональный read-only токен
  GitHub (fine-grained PAT с доступом к публичным репозиториям, без scope)
  для плановой и ручной сверки релизов стека. Задан — каждый запрос сверки в
  api.github.com (списки релизов/тегов и compare API — один общий JSON-порт)
  идёт с заголовком `authorization: Bearer <токен>`.
- Анонимный режим — по умолчанию: не задан или пустой — заголовка нет, бюджет
  60 запросов/час на egress-IP. Валидный токен поднимает бюджет до
  5000 запросов/час.
- Невалидный или отозванный токен — обычные данные: GitHub отвечает 401/403,
  статус пишется по компоненту как HTTP-ошибка, прежний кэш сохраняется — как
  при любом HTTP-статусе. Значение не логируется и не возвращается маршрутами.

## settings-en

| `MYRMIDON_STACK_GITHUB_TOKEN` | SUB | unset (anonymous) | Optional read-only GitHub token (fine-grained PAT, public repos, no scopes) for the stack release check: with it every api.github.com request of the check — release/tag lists and the compare API through the one shared JSON port — carries `authorization: Bearer <token>`, lifting the budget from the anonymous 60 req/h per egress IP to 5000 req/h. Secret class: the value is never logged and never returned by any route. Read on every check run, no server restart needed | Unset, empty or whitespace-only — anonymous mode, the previous behaviour byte-for-byte. Invalid or revoked token: GitHub answers 401/403, recorded per component as an HTTP error with the previous cache kept, like any other HTTP status |

## settings-ru

| `MYRMIDON_STACK_GITHUB_TOKEN` | SUB | не задана (анонимно) | Опциональный read-only токен GitHub (fine-grained PAT, публичные репозитории, без scope) для сверки релизов стека: с ним каждый запрос сверки в api.github.com — списки релизов/тегов и compare API через один общий JSON-порт — идёт с заголовком `authorization: Bearer <токен>`, поднимая бюджет с анонимных 60 запросов/час на egress-IP до 5000 запросов/час. Класс secret: значение не логируется и не возвращается маршрутами. Читается при каждом проходе сверки, перезапуск сервера не нужен | Не задана, пуста или только пробелы — анонимный режим, прежнее поведение байт в байт. Невалидный или отозванный токен: GitHub отвечает 401/403, пишется по компоненту как HTTP-ошибка с сохранением прежнего кэша — как любой HTTP-статус |
