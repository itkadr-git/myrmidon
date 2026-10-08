## divergence-new

<!-- after: 1.6.1 — HERMES-USAGE-COST: цена прогонов hermes_gateway из журнала LiteLLM -->

### 1.6.5 — F-06: модель прогона hermes_gateway в журнале прогонов (часть B)

Прогоны шлюза Hermes попадали в журнал с `unknown` вместо модели: терминальный
ответ шлюза не всегда называет модель, а адаптер читал её только оттуда. Теперь
адаптер берёт модель в порядке приоритета: поле `model` из ответа шлюза (верхний
уровень, затем внутри `usage`), затем имя маршрута LiteLLM `model_group` (тоже
верхний уровень и внутри `usage`) — оно совпадает с тем, что шлюз пишет в свой
журнал расходов, — и только если ответ не назвал ничего, модель конфигурации
запуска (карточка агента). Пустая строка и служебное значение `unknown` из ответа
моделью не считаются: они не подменяют следующий источник.

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.5-F06-MODEL | Модель прогона: приоритетная цепочка «`model` из ответа шлюза → `model_group` из ответа (в т.ч. внутри `usage`) → модель конфигурации запуска (`ctx.config.model`)», плюс отсев пустой строки и служебного `unknown`. Значение уходит в `AdapterExecutionResult.model`, откуда сервер пишет `usageJson.model` прогона | Вендор с маркером `myrmidon(F06-MODEL-TELEMETRY)`: `packages/adapters/hermes/src/gateway/server/execute.ts` (`extractModel`, новый `nonEmptyModel`, опциональное поле `configuredModel` у `mapFinalResultForTest` и его заполнение в финальном результате прогона), `packages/adapters/hermes/src/gateway/server/execute.test.ts` (блоки `mapFinalResultForTest` и новый `execute — run model telemetry`) | Журнал прогонов должен называть модель прогона: по нему считают стоимость и разбирают инциденты, а `unknown` у большинства прогонов шлюза делал эти прогоны неразличимыми. Модель из ответа шлюза достовернее карточки (маршрут мог быть перенаправлен), поэтому она и остаётся первым источником | `packages/adapters/hermes/src/gateway/server/execute.test.ts`: ответ с `model` — берётся он; без `model`, с `model_group` на верхнем уровне и внутри `usage` — берётся `model_group`; без обоих — модель конфигурации запуска; пустая/пробельная строка и `unknown` не считаются моделью и не маскируют источник; прогон через `execute()` кладёт модель карточки в результат, когда ответ шлюза её не назвал, и модель ответа, когда назвал | Никогда, наше поведение. Снять: вернуть в `extractModel` чтение только `record.model ?? record.usage.model`, убрать `nonEmptyModel` и поле `configuredModel` вместе со строками с маркером `myrmidon(F06-MODEL-TELEMETRY)` | (этот PR) |

## changelog-en

### The run journal names the model of a gateway run

- Runs of the Hermes gateway are no longer recorded with `unknown` as their
  model. The adapter now reads the model from the gateway's terminal answer in
  order of trust — the `model` field first, then the LiteLLM route name
  `model_group` (both at the top level and inside `usage`) — and falls back to
  the model the run was configured with when the answer names neither. An empty
  value or the `unknown` sentinel is not treated as a model.

## changelog-ru

### Журнал прогонов называет модель прогона шлюза

- Прогоны шлюза Hermes больше не записываются с моделью `unknown`. Адаптер
  читает модель из терминального ответа шлюза в порядке достоверности: сначала
  поле `model`, затем имя маршрута LiteLLM `model_group` (и на верхнем уровне,
  и внутри `usage`), а если ответ не назвал ни того, ни другого — модель, с
  которой прогон был запущен. Пустое значение и служебный `unknown` моделью не
  считаются.