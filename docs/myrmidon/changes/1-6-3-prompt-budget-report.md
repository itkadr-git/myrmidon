---
divergence-section: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации и глубокий разбор по кнопке
settings-section: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis
---

Release-cut notes (the collector folds only the table-row sections below;
apply these by hand when cutting the release that carries this PR):

1. DIVERGENCE.md: the folded divergence row belongs to part D; if a separate
   "## 1.6.3 — PROMPT-BUDGET, часть D: отчёт по флоту — средний размер промпта
   и стоимость" section is wanted, move the folded row into a new section with
   the standard table header (the PR originally shipped it as its own section).
2. SETTINGS.md: prepend this prose to the "1.6.3 — PROMPT-BUDGET C" section
   (or create the part-D section "1.6.3 — PROMPT-BUDGET D: fleet prompt report on the Costs screen" with it) before the folded
   settings-en row:

The fleet report has no environment variable of its own. It reads the live
instance setting `instance_settings.general.promptBudget` (owned by the sibling
part B of the same wave) and data the runs already store, so nothing has to be
restarted and no new store appears. The report rides on the existing
`GET /api/companies/:companyId/costs/by-agent` response as two additive
per-agent columns — `avgPromptTokens` (average prompt size of one run) and
`runsAboveThresholdPct` (share of judged runs above the threshold) — and shows
up as the columns "Avg prompt" and "% runs over threshold" with a sort toggle
on the Costs screen.

   Table header for a standalone part-D section, if created:
   | Variable | Function | Default | What it does | How to disable / special |
3. SETTINGS.ru.md: the RU file uses RU headings, so the collector's single
   settings-section key cannot reach it; append this prose and row to the
   "1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий
   разбор" section (or a new part-D section "1.6.3 — PROMPT-BUDGET D: отчёт по флоту на экране затрат"):

Своей переменной окружения у отчёта нет. Он читает живую настройку инстанса
`instance_settings.general.promptBudget` (её владелец — часть B той же волны) и
данные, которые прогоны уже хранят: ничего не перезапускается, нового хранилища
не появляется. Отчёт едет на существующем ответе
`GET /api/companies/:companyId/costs/by-agent` двумя аддитивными колонками на
агента — `avgPromptTokens` (средний размер промпта прогона) и
`runsAboveThresholdPct` (доля прогонов выше порога) — и виден на экране затрат
как колонки «Средний промпт» и «% прогонов выше порога» с переключателем
сортировки.

   | Переменная | Функция | Умолчание | Что делает | Как отключить / особые случаи |
   |---|---|---|---|---|
| `promptBudget` | 1.6.3-PROMPT-BUDGET D (здесь только чтение; пишет часть B) | не задана | Настройки порога промпт-бюджета. Прогон судится по `warnPct` процента окна модели, обслужившей прогон (`litellm_models.maxInputTokens`); средний размер промпта берётся из `heartbeat_runs.usageJson.promptBreakdown.total`, а если прогон разбивку не записал — из входных токенов его же cost_events | Ключа нет, `enabled: false` или нечитаемое значение — колонка доли остаётся пустой (`null`), а не нулём, и отчёт продолжает работать. Прогон с неизвестным окном модели входит в средний размер промпта, но исключается из доли. Удаление ключа убирает содержимое колонки, больше ничего не меняется |

## divergence

| 1.6.3-PROMPT-BUDGET-D | В существующий отчёт `costs/by-agent` добавлены две аддитивные колонки на агента: средний размер промпта прогона (токены) и доля прогонов выше порога. Размер промпта прогона берётся из `heartbeat_runs.usageJson.promptBreakdown.total` (контракт части A), а при отсутствии разбивки — из входных токенов cost_events того же прогона (свод по `heartbeatRunId`); прогоны без данных о промпте в отчёт не входят. Порог — из живой настройки `instance_settings.general.promptBudget` (контракт части B: `{enabled, warnPct, critPct}`): абсолютное значение = `warnPct` % от окна модели, обслужившей прогон (`litellm_models.maxInputTokens`, последняя запись на имя модели). Прогон с неизвестным окном не судится — он входит в средний размер, но исключается из доли (иначе доля молча падала бы в ноль). Без настроек порога, при `enabled: false` или нечитаемом значении доля пуста (`null`), а не `0`, и отчёт не падает. Настройка читается из сохранённого JSON `instance_settings.general` напрямую: нормализатор general сохраняет только ключи своей схемы, а ключ `promptBudget` принадлежит части B и до её слияния схемой не знается (локальное зеркало контракта, помеченное комментарием). Те же поля уходят в ответ роута; на экране затрат появились колонки «Средний промпт» и «% прогонов выше порога» и сортировка таблицы агентов по среднему промпту | Наши файлы: `server/src/myrmidon/prompt-budget/fleet-prompt-report.ts` + два сьюта (`fleet-prompt-report.myrmidon.test.ts`, `fleet-prompt-report.db.myrmidon.test.ts`); в вендоре помечены `myrmidon(1.6.3 PROMPT-BUDGET D)`: `server/src/services/costs.ts` (импорт + слияние колонок в `byAgent`), `server/src/routes/costs.ts` (комментарий о полях), `packages/shared/src/types/cost.ts` (две опциональные колонки в `CostByAgent`), `ui/src/api/costs.ts`, `ui/src/ui2/screens/costs/Ui2Costs.tsx`, `ui/src/ui2/i18n/locales.ts` (два ключа en+ru), док-строки SETTINGS/SETTINGS.ru | Пункт 4 эпика 1.6.3 PROMPT-BUDGET: отчёт по флоту — топ агентов по среднему размеру промпта и стоимости. Это расширение существующего `costs/by-agent`, а не новый стор: существующие колонки считаются тем же запросом, промпт-часть приходит отдельным агрегатом по прогонам и сливается по agentId, поэтому соединение не размножает строки cost_events и не искажает прежние суммы | `server/src/myrmidon/prompt-budget/fleet-prompt-report.myrmidon.test.ts`: размер прогона из разбивки и по входным токенам, малформы, разбор настроек порога, агрегаты на фикстуре двух агентов, доля без порога и с неизвестным окном, дедупликация прогонов. `server/src/myrmidon/prompt-budget/fleet-prompt-report.db.myrmidon.test.ts` (embedded postgres): существующие колонки не изменились, средний промпт и доля по фикстуре (2 агента, 3 прогона), прогон без разбивки считается по inputTokens, прогон с неизвестным окном исключён только из доли, сверка среднего с прямым SQL-запросом, отчёт по компании без событий пуст. `ui/src/ui2/screens/costs/Ui2Costs.myrmidon.test.tsx`: колонки отрисованы, прочерк без данных, сортировка таблицы по среднему промпту | Никогда, наше поведение. Снятие: удалить каталог `server/src/myrmidon/prompt-budget/`, импорт и слияние колонок в `costs.ts`, комментарии-маркеры, две колонки из `CostByAgent`, блок колонок/сортировки в `Ui2Costs.tsx` с двумя ключами локализации и секции SETTINGS | (этот PR) |

## settings-en

| `promptBudget` | 1.6.3-PROMPT-BUDGET D (read-only here; written by part B) | absent | Threshold settings of the prompt budget. The report judges a run against `warnPct` percent of the context window of the model that served the run (`litellm_models.maxInputTokens`); the average prompt size uses `heartbeat_runs.usageJson.promptBreakdown.total`, and the input tokens of the run's own cost events when the run recorded no breakdown | Absent, `enabled: false` or an unusable value — the share column stays empty (`null`), never zero, and the report keeps working. A run whose model window is unknown counts towards the average prompt size but is left out of the share. Removing the key removes the column content; nothing else changes |
