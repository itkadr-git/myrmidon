---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en

### 403 "key not allowed" is a permanent configuration error, not a retry (PERF-DIET-I)

A run whose Hermes gateway turn ended with the LiteLLM 403 message "key not
allowed to access model <model>" used to fall into the generic retry path:
every retry re-issued the same 403 (257 empty retries a day, perf-plan-v2
§1.4).

- The `hermes_gateway` adapter now tags such a failed run with the new
  `permanent_config_error` error family (case-insensitive signature match;
  the "Connection error." transient marking is unchanged).
- The recovery classifier routes both the new family and the raw 403 text
  (historical runs, other adapters) to the existing `configuration_incomplete`
  escalation: the issue goes to `blocked` with the cause recorded in the
  comment, no retry is scheduled, and the operator gets the deduplicated
  recovery-action attention card.

## changelog-ru

### 403 «key not allowed» — постоянная ошибка конфигурации, без ретраев (PERF-DIET-I)

Прогон, чей ход в Hermes-шлюзе закончился 403-ответом LiteLLM «key not allowed
to access model <model>», попадал в общий путь повторов: каждый повтор
заново получал тот же 403 (257 пустых ретраев в сутки, perf-plan-v2 §1.4).

- Адаптер `hermes_gateway` теперь помечает такой упавший прогон новым семейством
  `permanent_config_error` (сигнатура ищется без учёта регистра; пометка
  «Connection error.» как transient не изменилась).
- Классификатор восстановления ведёт и новое семейство, и сырой текст 403
  (исторические прогоны, другие адаптеры) по существующей ветке
  `configuration_incomplete`: задача уходит в `blocked` с причиной в
  комментарии, повтор не планируется, оператор получает одну дедуплицированную
  карточку attention о действии восстановления.

## divergence

| PERF-DIET-I | Классификация сбоя `hermes_gateway_run_failed`, чей текст несёт сигнатуру отказа ключа LiteLLM («key not allowed», регистронезависимо), помечается `errorFamily: "permanent_config_error"`; `classifyAdapterFailureForRecovery` ведёт это семейство и текст «key not allowed to access model» (до гейта кодов ошибок — прогон шлюза персистит `hermes_gateway_run_failed`) в ветку `configuration_incomplete`: задача блокируется с причиной, повтор не планируется; поведение «Connection error.» (transient) не изменено | `packages/adapter-utils/src/types.ts` (union `AdapterExecutionErrorFamily`), `packages/adapters/hermes/src/gateway/server/execute.ts` (`mapFinalResultForTest`), `server/src/services/recovery/service.ts` (`classifyAdapterFailureForRecovery`) | 403 от LiteLLM — постоянная проблема пары ключ/модель: повтор повторяет тот же отказ (257 пустых ретраев в сутки, perf-plan-v2 §1.4), а вендорный классификатор не имел ни семейства, ни текстового покрытия «key not allowed» | `packages/adapters/hermes/src/gateway/server/execute.test.ts` (403-текст → `permanent_config_error`, регистронезависимость, «Connection error.» остаётся `transient_upstream`), `server/src/services/recovery/provider-failure-classification.test.ts` (текст 403 и семейство → `configuration_incomplete`; негативный контроль — transient и прочие коды без изменений) | Никогда, наше поведение. Удалить куски `myrmidon(PERF-DIET-I)` и новые тесты, если вендор накроёт отказ ключа постоянным семейством сам | — |
