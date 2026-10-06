---
divergence-section: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации и глубокий разбор по кнопке
settings-section: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор
---

## changelog-en

### 1.6.3 PROMPT-BUDGET B: prompt-size thresholds and over-threshold signals (OPE-4806)

- Live company settings `instance_settings.general.promptBudget`
  (`warnPct` / `critPct` / `enabled` / `fallbackWindowTokens`), edited on the
  Instance → General "Prompt budget" panel without a restart.
- Attention feed: one card per agent whose last run's prompt crosses the
  threshold (`sourceKind prompt_budget_alert`, warn → medium, crit → high);
  the detail names the top-3 prompt parts, the window and the crossed level.
- Agent card (Overview): "Prompt budget" section with the window share, totals
  and the per-part breakdown of the last run.
- API: `GET/PUT /api/myrmidon/companies/:companyId/prompt-budget/settings`,
  `GET .../prompt-budget/status`.

## changelog-ru

### 1.6.3 PROMPT-BUDGET B: пороги размера промпта и сигналы о превышении (OPE-4806)

- Живые настройки компании `instance_settings.general.promptBudget`
  (`warnPct` / `critPct` / `enabled` / `fallbackWindowTokens`), правятся на
  панели «Prompt budget» (Экземпляр → Общие) без перезапуска.
- Лента внимания: одна карточка на агента, чей последний прогон пересёк порог
  (`sourceKind prompt_budget_alert`, warn → medium, crit → high); деталь
  называет топ-3 части промпта, окно и пересечённый уровень.
- Карточка агента (обзор): секция «Prompt budget» с долей окна, суммами и
  разбивкой по частям последнего прогона.
- API: `GET/PUT /api/myrmidon/companies/:companyId/prompt-budget/settings`,
  `GET .../prompt-budget/status`.

## divergence

| 1.6.3-PROMPT-BUDGET-B | Пороги warn/crit промпта (проценты от окна модели агента) — живые настройки `instance_settings.general.promptBudget` (`warnPct`, `critPct`, `enabled`, `fallbackWindowTokens`, аддитивный `optimizerAgentId` части C), правятся на панели «Prompt budget» без перезапуска (проход и status перечитывают строку каждый раз). Модуль `server/src/myrmidon/prompt-budget/` по образцу wip-limit: settings/routes/status/sweep/attention/signal. Окно модели — latest-seen `litellm_models.maxInputTokens`, при неизвестном окне — `fallbackWindowTokens` (200k). Лента внимания: новый `sourceKind prompt_budget_alert` + генератор-блок (пересчёт на каждый список: карточка живёт, пока последний прогон выше порога; warn → medium, crit → high; деталь — топ-3 части + окно + порог) + case в decision-queues. Свип пишет один системный комментарий на агента в сутки (UTC) в последнюю in_progress задачу. UI: панель в Instance → General, секция «Prompt budget» на карточке агента, бейдж-компонент | Новые файлы: `packages/shared/src/myrmidon-prompt-budget.ts`, `server/src/myrmidon/prompt-budget/{settings,status,attention,signal,sweep,routes,index}.ts`, `server/src/myrmidon/prompt-budget/prompt-budget.myrmidon.test.ts`, `ui/src/components/myrmidon/prompt-budget/{promptBudgetApi.ts,promptBudgetConfig.ts,promptBudgetConfig.myrmidon.test.ts}`, `ui/src/components/myrmidon/{PromptBudgetSettingsPanel.tsx,PromptBudgetStatusSection.tsx,PromptBudgetStatusSection.myrmidon.test.tsx,AgentPromptBudgetBadge.tsx,AgentPromptBudgetBadge.myrmidon.test.tsx}`. В вендоре помечены `myrmidon(1.6.3 PROMPT-BUDGET B)`: `packages/shared/src/{index.ts,types/attention.ts,validators/instance.ts}`, `server/src/services/{instance-settings.ts,attention.ts,decision-queues.ts}`, `server/src/app.ts`, `server/src/index.ts`, `ui/src/pages/{InstanceGeneralSettings.tsx,AgentDetail.tsx}` | Эпик 1.6.3 PROMPT-BUDGET, часть B: пороги меняются без перезапуска, пересечение видно в ленте внимания и на карточке агента с разбивкой по частям | `server/src/myrmidon/prompt-budget/prompt-budget.myrmidon.test.ts` (порог от окна модели; смена настроек видна следующей оценке; карточка появляется/исчезает/переградуировывается; прогон без разбивки сигналит по total без частей; неизвестное окно → fallback; выключено — без сигнала; dedup сигнала раз в сутки), `ui/src/components/myrmidon/prompt-budget/promptBudgetConfig.myrmidon.test.ts`, `ui/src/components/myrmidon/{AgentPromptBudgetBadge,PromptBudgetStatusSection}.myrmidon.test.tsx` | Никогда, наше поведение. Снятие: удалить перечисленные новые файлы, строки с маркером в вендорских файлах, секции PROMPT-BUDGET B из SETTINGS | (этот PR) |

## settings-ru

| Поле | По умолчанию | Что делает | Границы / особое |
|---|---|---|---|
| `promptBudget.warnPct` | `70` | Уровень warn, проценты от окна модели; последний прогон на нём или выше поднимает среднюю карточку | Целое 1–99, строго ниже `critPct`; нечитаемая строка хранилища откатывается на полный набор умолчаний |
| `promptBudget.critPct` | `90` | Уровень crit, проценты от окна модели; последний прогон на нём или выше поднимает высокую карточку | Целое 2–100, строго выше `warnPct` |
| `promptBudget.enabled` | `true` | `false` = статус показывается, но карточка и комментарий-сигнал не создаются | Проход пропускается до любого запроса |
| `promptBudget.fallbackWindowTokens` | `200000` | Окно, от которого считаются пороги, когда у модели агента нет известного `maxInputTokens` | Целое ≥ 1000; строка статуса помечает его `windowIsFallback: true` |

## settings-en-append

<!-- section: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis -->
The live thresholds of part B (the same `promptBudget` settings area):

| Field | Default | What it does | Bounds / special |
|---|---|---|---|
| `promptBudget.warnPct` | `70` | Warn level, percent of the model window; a last run at or above it raises a medium card | Whole number 1–99, strictly below `critPct`; an unreadable stored row falls back to the full default set |
| `promptBudget.critPct` | `90` | Crit level, percent of the model window; a last run at or above it raises a high card | Whole number 2–100, strictly above `warnPct` |
| `promptBudget.enabled` | `true` | `false` = the status is still reported, but no card and no signal comment are produced | The sweep skips the pass before any query |
| `promptBudget.fallbackWindowTokens` | `200000` | The window the thresholds count against when the agent's model has no known `maxInputTokens` | Whole number ≥ 1000; the status row marks it with `windowIsFallback: true` |
