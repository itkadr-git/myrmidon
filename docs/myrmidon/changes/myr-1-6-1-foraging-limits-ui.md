---
settings-section: 1.6 — FORAGING (source registry, snapshot comparison, skill candidates)
---

## changelog-en

### Learning switch and spend limits (FORAGING-LIMITS-UI)

- The learning switch, the pass interval, the same-host read pause, the
  per-pass budget, the **daily** and **monthly** company ceilings, the per-agent
  and per-role limits, the hard/soft (ask the owner) enforcement mode and the
  cost-per-task auto-off threshold are instance settings now: the "Learning
  (foraging)" section of Instance → General
  (`GET`/`PATCH /api/myrmidon/foraging-settings`), key `general.foraging`.
- No restart: the sweep re-resolves the settings row before every pass, a
  changed value applies with the next pass. The 1.6 env variables
  (`MYRMIDON_FORAGING_*`) stay forced per-key overrides of the matching field,
  the built-in default is the floor; the panel shows the origin of each value.
  `MYRMIDON_FORAGING_KEY_SECRET` stays env-only: it names a company secret, not
  a limit.
- When a limit stops a pass (sources after the stop stay untouched), a
  `foraging_limit` card lands in the attention feed (it clears when a pass
  runs without a stop; the auto-off card stays until learning is re-enabled).
  Soft mode marks the signal as a question to the owner: raise the limit or
  switch learning off.
- The learning spend is tracked on its own: a `foraging_spend_events` table
  (cents, role, agent, source URL) and one `training_charge` finance event per
  pass — Costs shows learning as its own "Training" line, by agent and source
  (`GET /api/myrmidon/companies/:companyId/foraging/spend`).
- Cost auto-off: when the mean cost per task (BASELINE) rises above the
  threshold from the settings, learning switches itself off and signals the
  attention feed.

## settings-en

| `MYRMIDON_FORAGING_DAILY_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced per-key override of the stored `general.foraging` `dailyBudgetCents` (company ceiling per UTC day, cents); the interface value applies unless the variable is set | Unset — the settings row (or no limit) applies; parse failure — the variable is ignored |
| `MYRMIDON_FORAGING_MONTHLY_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced override of `monthlyBudgetCents` (company ceiling per UTC month, cents) | Unset — the settings row applies; parse failure — ignored |
| `MYRMIDON_FORAGING_ROLE_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced override of `roleBudgetCents` (daily ceiling for one role, cents) | Unset — the settings row applies; parse failure — ignored |
| `MYRMIDON_FORAGING_AGENT_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced override of `agentBudgetCents` (daily ceiling for one agent, cents) | Unset — the settings row applies; parse failure — ignored |
| `MYRMIDON_FORAGING_ENFORCEMENT` | FORAGING-LIMITS-UI | unset (settings row: `hard`) | Forced override of `enforcement`: only `hard`/`soft` are honoured, anything else falls through to the settings row | Unset — the settings row applies |
| `MYRMIDON_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS` | FORAGING-LIMITS-UI | unset (check off) | Forced override of `autoOffCostPerTaskCents`: mean cost per task (BASELINE) above the threshold switches learning off and signals the attention feed | Unset or unparseable — the settings row applies; `null` in the row — the check is off |

## changelog-ru

### Обучение и лимиты на него (FORAGING-LIMITS-UI)

- Выключатель обучения, интервал прохода, пауза между чтениями одного хоста,
  бюджет одного прохода, **суточный** и **месячный** лимит на компанию, лимит
  на агента и на роль, режим «жёсткий / мягкий (спросить владельца)» и порог
  автоотключения по стоимости задачи — настройки инстанса: раздел
  «Learning (foraging)» в Instance → General
  (`GET`/`PATCH /api/myrmidon/foraging-settings`), ключ `general.foraging`.
- Действует без рестарта: свип перечитывает строку настроек перед каждым
  проходом, смена значения вступает в силу со следующего прохода. Env-переменные
  1.6 (`MYRMIDON_FORAGING_*`) остаются принудительным переопределением по
  каждому ключу, умолчание — пол; происхождение каждого значения видно в
  панели. `MYRMIDON_FORAGING_KEY_SECRET` остаётся только env: это имя секрета
  компании, а не лимит.
- При достижении лимита проход останавливается (источники после остановки не
  трогаются), в «Ждёт меня» падает карточка `foraging_limit` (уходит, когда
  проход прошёл без остановки; карточка автоотключения держится, пока
  обучение снова не включат). Мягкий режим помечает сигнал как вопрос
  владельцу: поднять лимит или выключить обучение.
- Расход обучения учитывается отдельно: таблица `foraging_spend_events`
  (центы, роль, агент, URL источника) и одна финансовая строка
  `training_charge` на проход — в Расходах обучение видно отдельной строкой
  «Training», по агентам и источникам
  (`GET /api/myrmidon/companies/:companyId/foraging/spend`).
- Автоотключение по стоимости: если средняя стоимость задачи (BASELINE)
  поднимается выше порога из настроек, обучение выключается само и сигналит в
  «Ждёт меня».
