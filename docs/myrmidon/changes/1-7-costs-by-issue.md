## changelog-en

### Endpoint costs/by-issue for expensive tasks (1.7-COSTS-BY-ISSUE)

- New endpoint `GET /api/companies/:companyId/costs/by-issue?from&to&limit` returning top expensive tasks ordered by `costCents` descending.
- Grouping `cost_events` by `issue_id`, distinct `heartbeat_run_id` as `runs`, joining `issues` for `identifier` and `title`.
- Default `limit=20`, maximum `100` (`>100` returns HTTP 400).

## changelog-ru

### Эндпоинт costs/by-issue для дорогих задач за период (1.7-COSTS-BY-ISSUE)

- Новый эндпоинт `GET /api/companies/:companyId/costs/by-issue?from&to&limit` отдаёт массив дорогих задач по убыванию `costCents`.
- Группировка `cost_events` по `issue_id`, число различных `heartbeat_run_id` как `runs`, соединение с `issues` для получения `identifier` и `title`.
- `limit` по умолчанию 20, максимум 100 (больше 100 возвращает HTTP 400).

## divergence-new

### 1.7 — UI-2.0 РАСХОДЫ: эндпоинт costs/by-issue (дорогие задачи за период)

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.7-COSTS-BY-ISSUE | Новый эндпоинт `GET /api/companies/:companyId/costs/by-issue?from&to&limit` отдаёт массив дорогих задач `{ issueId, identifier, title, costCents, inputTokens, cachedInputTokens, outputTokens, runs }` по убыванию `costCents`. Limit по умолчанию 20, максимум 100 (>100 → 400). Метод `byIssue` группирует `cost_events` по `issue_id`, джойнит `issues` для `identifier`/`title`, считает `runs` как `count(distinct heartbeat_run_id)`. События без `issue_id` в выборку не входят. | `server/src/services/costs.ts`, `server/src/routes/costs.ts`, `server/src/routes/openapi.ts` | ia-v2 §2.1.4 и §6.1 G3 (OPE-10128): блок «Дорогие задачи за период» на экране «Расходы» UI 2.0 | `server/src/__tests__/costs-service.test.ts` (порядок по убыванию, limit=2, изоляция компаний, согласованность с summary.spendCents) | Никогда, наше поведение. Если вендор добавит свой by-issue — сверить контракты | #2121 |
