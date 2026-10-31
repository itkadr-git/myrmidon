---
divergence-section: Трек 1 — платформа
---

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| OPE-4041-A | `POST /api/issues/{id}/stalled-review-decision` явно объявлен board-only в OpenAPI, в соответствии с `assertBoard`. Агентского пути записи нет by design; решение этапа ревьюер записывает через `PATCH /api/issues/{id}` со status и comment в одном запросе (approve = `done`, request changes = `in_progress`) | `server/src/routes/openapi.ts` (`BOARD_ONLY_OPERATIONS`); `server/src/__tests__/openapi-routes.test.ts` | Маршрут и сервис предназначены для board-актора; контракт не должен обещать агентский доступ | `server/src/__tests__/openapi-routes.test.ts` (actor=board и только board security); `server/src/__tests__/issue-stalled-review-decision-routes.test.ts` (agent bearer получает 403) | Никогда, поведение board-only соответствует намерению; если вендорный контракт изменится, пересмотреть guard и тесты | PR #1335 |
