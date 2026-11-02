---
divergence-section: UI-2.0 — оболочка нового интерфейса (UI-0a)
---

## divergence

| 1.7-UI2-COSTS-SUMMARY | В ответ `GET /companies/:companyId/costs/summary` добавлены три поля: `unpricedEvents` (число cost_events с `cost_status = 'unpriced'` за запрошенный период), `unpricedTokens` (сумма токенов input + cached + output этих событий) и `forecastCents` (прогноз расхода до конца текущего календарного месяца UTC: расход с начала месяца ÷ прошедшие дни × дней в месяце, округление до цента; null если прошло меньше суток или расход 0). Существующие поля `spendCents`, `budgetCents`, `utilizationPercent` не изменились. | Вендор с маркером `myrmidon(1.7 UI-2.0 COSTS-SUMMARY)`: `packages/shared/src/types/cost.ts` (`CostSummary`), `server/src/services/costs.ts` (`summary` и `getMonthlySpendTotal`), `server/src/routes/costs.ts`, `server/src/__tests__/costs-service.test.ts` | ia-v2 §6.1 G2 и §2.1.4 (OPE-10126): экран «Расходы» в UI-2.0 показывает полосу «N событий без цены» и прогноз расхода | `server/src/__tests__/costs-service.test.ts` (фикстура unpriced событий, фикстуры прогноза: 10-е число, первые сутки, расход 0; неизменность старых полей и полный набор ключей; GET /costs/summary HTTP) | Никогда, контракт UI-2.0 | PR #2111 |
