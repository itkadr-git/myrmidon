---
divergence-section: 1.6 — экран «Autonomy matrix» (AUTONOMY-MATRIX, часть B)
---

## changelog-en

### Autonomy matrix enforced in the tool gateway (1.6 AUTONOMY-MATRIX, gateway half)

- Before an agent's tool call is executed, the tool gateway maps the tool
  onto an action class by name and resolves the matrix verdict for the
  agent's role — at the point of action, before the access policy and before
  any provider dispatch. A `forbidden` verdict refuses the call with 403
  `autonomy_forbidden` (the upstream is never called); `approval_required`
  parks the call in the existing `tool_action_requests` holding conveyor
  (409 `approval_required`, an approval card, execution after approval via
  `approvedActionRequestId`); `allowed` and every non-agent caller pass to
  the ordinary policy path unchanged. A tool with no action class is not
  governed by the matrix.
- The tool → action-class mapping is configurable per instance without a
  restart: stored settings (`instance_settings.general.myrmidonAutonomyToolMapping`)
  win, then the `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` env override, then the
  built-in defaults (the three classes of the design — merge / deploy /
  external_message — with their common tool-name patterns). Operator guide:
  [guides/autonomy-matrix-tool-gateway.md](guides/autonomy-matrix-tool-gateway.md).

## changelog-ru

### Матрица автономии исполняется в шлюзе инструментов (1.6 AUTONOMY-MATRIX, шлюзовая половина)

- Перед исполнением вызова инструмента агентом шлюз сопоставляет инструмент с
  классом действия по имени и разрешает вердикт матрицы для роли агента — в
  точке действия, до политики доступа и до любого обращения к провайдеру.
  Вердикт `forbidden` отклоняет вызов с 403 `autonomy_forbidden` (апстрим не
  вызывается); `approval_required` уводит вызов в существующий конвейер
  держания `tool_action_requests` (409 `approval_required`, карточка
  одобрения, исполнение после одобрения через `approvedActionRequestId`);
  `allowed` и любой не-агент проходят обычный путь политики без изменений.
  Инструмент без класса действия матрице не подчиняется.
- Сопоставление «инструмент → класс действия» настраивается на инстансе без
  перезапуска: сначала сохранённые настройки
  (`instance_settings.general.myrmidonAutonomyToolMapping`), затем
  переопределение из `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON`, затем встроенные
  умолчания (три класса постановки — merge / deploy / external_message — с
  типовыми паттернами имён). Руководство оператора:
  [guides/autonomy-matrix-tool-gateway.ru.md](guides/autonomy-matrix-tool-gateway.ru.md).

## divergence

| 1.6-AUTONOMY-GW | Матрица автономии в шлюзе инструментов: перед исполнением вызова инструмента агентом шлюз сопоставляет инструмент с классом действия (`server/src/myrmidon/autonomy/tool-mapping.ts` — полное имя инструмента шлюза или «голое» имя апстрим-инструмента после `:`, `_`/`-` равны; умолчания — ровно три класса из эпика: merge/deploy/external_message с типовыми паттернами имён, остальное — без класса и не подчиняется матрице) и разрешает вердикт матрицы для роли агента (`dbAutonomyVerdictForAgent` в `server/src/myrmidon/autonomy/gate.ts` — тот же порядок agent > role > default, не-агент читается как allowed). `forbidden` → 403 с кодом `autonomy_forbidden` до политики доступа и до провайдера (апстрим не вызывается, инвокация и запрос действия не создаются); `approval_required` → существующее держание `tool_action_requests` (запись инвокации, карточка одобрения, повторный вызов через `approvedActionRequestId` исполняет удержанное действие). Сопоставление настраивается без перезапуска: `instance_settings.general.myrmidonAutonomyToolMapping` (resolver читает строку на каждый вызов; приоритет настройки → env `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` → умолчания, источник показывается настройками) | Наши файлы: `server/src/myrmidon/autonomy/tool-mapping.ts`, `server/src/myrmidon/autonomy/tool-mapping-store.ts`, `server/src/services/tool-gateway.myrmidon.test.ts`, доки `docs/myrmidon/guides/autonomy-matrix-tool-gateway.{md,ru.md}`; в вендоре помечены `myrmidon(1.6-AUTONOMY-GW)`: `server/src/services/tool-gateway.ts` (импорт + блок вердикта в `executeTool` до `decideToolAccess`), `server/src/myrmidon/autonomy/gate.ts` (функция `dbAutonomyVerdictForAgent`), `packages/shared/src/types/tool-access.ts` (код причины `autonomy_approval_required`) | Эпик 1.6 AUTONOMY-MATRIX: матрица хранилась и редактировалась, но в точке действия не исполнялась; `dbAutonomyGate(...).assertAllowed` нигде не вызывался. Точка действия для вызовов инструментов — шлюз | `server/src/services/tool-gateway.myrmidon.test.ts` (7: сопоставление имён merge/deploy/external_message, полные и апстрим-имена, отсутствие класса; на embedded postgres против настоящего сервиса шлюза с фейковым удалённым MCP-апстримом: merge=forbidden у роли engineer → 403 `autonomy_forbidden`, апстрим не вызван, запроса нет; external_message=approval_required → 409 `approval_required`, строка `tool_action_requests` pending, после одобрения вызов с `approvedActionRequestId` исполняется, апстрим вызван, статус executed; инструмент без класса идёт обычным путём при полностью запретительной матрице; не-агент (Test-tab) не подчиняется матрице) | Никогда, наше поведение. При переносе: сохранить блок `myrmidon(1.6-AUTONOMY-GW)` в `executeTool` до `decideToolAccess`; если вендор заведёт собственную точку автономии в шлюзе — удалить блок, функцию в gate.ts, код причины в shared и тесты, оставив поведение вендора | (этот PR) |

## settings-en-new

<!-- after: 1.6 — AUTONOMY-MATRIX (Part A: matrix, enforcement, regulations API) -->

### 1.6.2 — AUTONOMY-MATRIX: the matrix in the tool gateway (tool -> action class mapping)

The gateway enforcement half of the autonomy matrix (`server/src/myrmidon/autonomy/tool-mapping{,-store}.ts`,
integration in `server/src/services/tool-gateway.ts`). Before an agent's tool call is
executed, the tool is mapped onto an action class and the matrix verdict is resolved:
`forbidden` → 403 `autonomy_forbidden`; `approval_required` → the existing
`tool_action_requests` holding conveyor; `allowed` (and every non-agent caller) → the
ordinary policy path. A tool with no action class is not governed. Full guide:
[guides/autonomy-matrix-tool-gateway.md](guides/autonomy-matrix-tool-gateway.md),
[guides/autonomy-matrix-tool-gateway.ru.md](guides/autonomy-matrix-tool-gateway.ru.md).

The mapping is configurable per instance without a restart: it lives under
`instance_settings.general.myrmidonAutonomyToolMapping` and changes take effect on the
next gateway call (the resolver reads the row per call). The env variable below is only
the forced override for an instance that never saved the setting; precedence:
stored settings → env → built-in defaults (the three classes of the design with their
default tool-name lists: merge / deploy / external_message — see the guide). The matrix
settings screen does not edit this mapping yet; it is written from the API or the env
override.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` | 1.6-AUTONOMY-GW | unset (built-in defaults) | A JSON array of `{ "tool": "<name>", "actionClass": "<class>" }` entries used when nothing is stored in `instance_settings.general.myrmidonAutonomyToolMapping`. Full gateway tool names win over bare upstream tool names; `_` and `-` compare equal | Any non-array / unparsable value is ignored (the built-in defaults apply). Once a mapping is saved from the settings key, the environment stops mattering |
