---
divergence-section: 1.7 — BUDGET-CONFIG A: лимиты расхода по уровням иерархии, API и журнал изменений
---

## changelog-en

### Queue admission enforces budget limits (1.7-BUDGET-CONFIG-ADMISSION)

- Hierarchy spend limits (`budget_limits`) now take effect on run admission in the queue.
- `getInvocationBlock` checks effective limits (issue -> foraging -> caste -> project nest -> company nest) against spend from `litellm_cost_events` and sweep state.
- Only hard, active, over-budget limits block runs; soft limits and default signal-only mode do not refuse admission.
- Raising a limit via API or UI takes effect immediately without restart.

## changelog-ru

### Допуск в очередь учитывает лимиты расхода (1.7-BUDGET-CONFIG-ADMISSION)

- Лимиты расхода иерархии (`budget_limits`) теперь действуют при допуске запуска в очереди.
- `getInvocationBlock` проверяет эффективный лимит (задача -> фуражировка -> каста -> гнездо-проект -> гнездо-компания) по расходу `litellm_cost_events` и состоянию свипа.
- Только жёсткие (`hard`), активные и превышенные лимиты блокируют запуск; мягкие (`soft`) лимиты и режим «только сигнал» по умолчанию не блокируют допуск.
- Повышение лимита через API или интерфейс начинает действовать немедленно без перезапуска.

## divergence

| 1.7-BUDGET-CONFIG-ADMISSION | Лимиты иерархии A действуют при допуске запуска в очереди: каждый `getInvocationBlock` (тот же гейт, что у вендорских budget_policies и токен-квоты) заново разрешает эффективный лимит задачи (задача → фуражировка → каста → гнездо-проект → гнездо-компания, прецедентность резолвера A), считает расход уровня/ссылки/периода этого лимита (`litellm_cost_events`, foraging — состояние свипа) и отказывает запуску, только если режим строки `hard`, строка активна и расход за период строго больше суммы; причина называет уровень, расход и лимит. Soft при допуске не отказывает (паузы — часть B); глобальный «только сигнал» (умолчание ВКЛ) не отказывает вовсе. Хук `resolveBudgetLimitAdmissionBlock` в `BudgetServiceHooks` (отсутствие хука = вендорское поведение), проводка в `heartbeat.ts` — все пути допуска (очередь, гейт побудок, плагинные побудки) наследуют гейт; кэша нет — поднятие лимита освобождает уже следующий допуск | Наши файлы: `server/src/myrmidon/budget-limits/admission.ts`, тесты `admission.unit.test.ts` + `admission.db.myrmidon.test.ts`, фрагмент `docs/myrmidon/changes/1-7-budget-limits-admission.md`, разделы в `docs/myrmidon/guides/budget-limits{.ru,}.md`; в вендоре помечены `myrmidon(1.7-BUDGET-CONFIG)`: `server/src/services/budgets.ts` (хук + рука в `getInvocationBlock`), `server/src/services/heartbeat.ts` (проводка) | Эпик 1.7 BUDGET-CONFIG: критерий «изменение лимита действует в очереди в течение минуты без рестарта» — очередь ранее читала только вендорские budget_policies, иерархия A ни на что не влияла | `server/src/myrmidon/budget-limits/admission.unit.test.ts` (граница over/equal, signal-only, soft, без лимита, уровень→скоуп, формулировка периода), `admission.db.myrmidon.test.ts` на живом embedded Postgres через реальный `budgetService` (глубокий уровень выигрывает; подъём лимита стором освобождает следующий допуск; дефолт signal-only не отказывает, enforce отказывает; без хука — вендорское поведение) | Вместе со слоем A (разделы 1.7-BUDGET-CONFIG-A) | #1837 |
