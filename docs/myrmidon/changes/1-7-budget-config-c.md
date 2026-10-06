## changelog-en

### LiteLLM budget projection (BUDGET-CONFIG C)

- Limits saved on the board are projected into the LLM gateway's own budgets
  without a restart and within a minute: per-key budgets via `/key/update`
  (addressed by the M2-B key alias) and tag budgets via `/budget/update` on
  the stable `myrm-<level>-<scope>` tag. One point of change: the limit is
  edited on the board. A per-company sweep (interval from the stored
  document, default 30 s; env is a forced override only) pushes changed
  limits and compares both sides: a manual gateway edit is a divergence —
  signalled as a system-notice comment, never silently overwritten; the way
  out is re-saving the limit or `POST …/litellm-budget-sync/re-sync`. The
  global signal-only mode is on by default, so no projected limit stops work
  until the owner turns it off.

## changelog-ru

### Проекция бюджетов LiteLLM (BUDGET-CONFIG C)

- Лимиты, сохранённые на доске, проецируются в собственные бюджеты LLM-шлюза
  без перезапуска и в пределах минуты: бюджеты ключей через `/key/update`
  (адресация по M2-B алиасу) и бюджеты тегов через `/budget/update` на
  стабильном теге `myrm-<уровень>-<скоуп>`. Одна точка изменения — лимит
  правится на доске. Свип на компанию (интервал из документа, умолчание
  30 с; env — только принудительное переопределение) записывает изменённые
  лимиты и сверяет обе стороны: ручная правка в шлюзе — расхождение,
  сигнал системным комментарием, никогда молчаливая перезапись; выход —
  пересохранение лимита или `POST …/litellm-budget-sync/re-sync`. Глобальный
  режим «только сигнал» включён по умолчанию — спроецированный лимит не
  останавливает работу, пока владелец его не выключит.

## divergence-new

<!-- after: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички -->

### 1.7 — BUDGET-CONFIG C: проекция лимитов в бюджеты ключей и тегов LiteLLM

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-BUDGET-CONFIG-C | Лимиты расхода, сохранённые на доске, проецируются в собственные бюджеты LLM-шлюза (LiteLLM) без перезапуска и в пределах минуты: бюджеты ключей агентов через `/key/update` (адресация по M2-B алиасу секрета) и бюджеты тегов через `/budget/update` на стабильном теге `myrm-<уровень>-<скоуп>`. Одна точка изменения — лимит правится на доске. Свип на компанию (интервал из документа `sweepIntervalSec`, умолчание 30 с ≤ 60 с критерия; env — только принудительное переопределение `MYRMIDON_LITELLM_BUDGET_SYNC_INTERVAL_SEC`, GET настроек называет источник) делает трёхстороннее сравнение: доска ≠ спроецировано → записать и зафиксировать `projected`; доска = спроецировано ≠ шлюз → ручная правка в шлюзе = расхождение: сигнал системным комментарием в самой свежей in_progress задаче компании (дедуп по цели и UTC-дню через ключ в метаданных), НИКОГДА молчаливая перезапись; выход — пересохранение лимита или `POST …/litellm-budget-sync/re-sync` (board) — принудительный проход. Глобальный режим «только сигнал» по умолчанию включён: все бюджеты пишутся мягкими, жёсткий блок — только при выключенном переключателе и `mode: "block"`. Документ на компанию в `general.myrmidonBudgetProjectionCompanies`, без миграций; preserve-строка в instance-settings помечена `myrmidon(1.7-BUDGET-CONFIG-C)` | Наши файлы: `server/src/myrmidon/litellm-budget-sync/{index,gateway,service,settings,sweep,routes}.ts` + тест `litellm-budget-sync.myrmidon.test.ts`; аддитивно: `packages/shared/src/myrmidon-budget-projection.ts` (+ экспорт в `packages/shared/src/index.ts`), монтирование роутов в `server/src/app.ts` (импорт + `api.use`, метка `myrmidon(1.7-BUDGET-CONFIG-C)`), старт свипа в `server/src/index.ts` (импорт + вызов `startLitellmBudgetSync`, метка), preserve-строка в `server/src/services/instance-settings.ts` (метка); строки в `docs/myrmidon/SETTINGS.md`, гайды `docs/myrmidon/guides/litellm-budget-projection{.ru,}.md`, строки в CHANGELOG. Вендор не тронут: правок файлов вендора нет | Эпик 1.7 BUDGET-CONFIG (часть C): лимит, изменённый в доске, действует в LiteLLM за минуту; ручная правка в LiteLLM не перезатирается молча, а сигнализируется | `server/src/myrmidon/litellm-budget-sync/litellm-budget-sync.myrmidon.test.ts`: контракт настроек (signal-only по умолчанию, деградация битого документа, тег-имена, интервал по умолчанию ≤ 60 с, границы клампа), проход проекции (лимит касты доходит тегом и ключами за один проход, идемпотентность, подъём лимита, мягкость при signal-only / жёсткость при block+off, выключенный документ — ноль записей, нулевая сумма снимает проекцию), расхождения (ручная правка тега/ключа — сигнал без перезаписи, тело сигнала называет оба числа и способ выхода, дедуп-ключ стабильный, принудительный re-sync снимает расхождение, сравнение с округлением до целого доллара) | Никогда, наше поведение. Снять: каталог `server/src/myrmidon/litellm-budget-sync/`, модуль `packages/shared/src/myrmidon-budget-projection.ts` (+ экспорт), строки app.ts/index.ts/instance-settings.ts с меткой `myrmidon(1.7-BUDGET-CONFIG-C)`, разделы в SETTINGS/DIVERGENCE/гайдах | (этот PR) |

## settings-en-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis -->

### 1.7 — LiteLLM budget projection (BUDGET-CONFIG C)

Settings of `server/src/myrmidon/litellm-budget-sync/` (the 1.7 BUDGET-CONFIG
epic, part C). The feature is off by default: the sweep is a no-op and the
status/re-sync endpoints answer 503 `enabled: false` until the instance names
the gateway contour (the M2-A/M2-B variables below) AND the company's stored
document turns the master switch on. Limits live per company in
`instance_settings.general.myrmidonBudgetProjectionCompanies[companyId]`
(no new migration — the JSON-column pattern the STT overrides use) and are
managed through `GET`/`PUT /api/myrmidon/companies/:companyId/litellm-budget-sync/settings`;
the signal-only global mode is on by default, so no projected limit stops
work until the owner turns it off. See the guide
[guides/litellm-budget-projection.md](guides/litellm-budget-projection.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_LITELLM_BUDGET_SYNC_INTERVAL_SEC` | 1.7-BUDGET-CONFIG-C | `30` | The sweep interval of the budget projection pass, in seconds — a changed limit reaches LiteLLM within this window (the acceptance criterion is ≤ 60 s). The stored per-company `sweepIntervalSec` is the source the UI writes; this variable is a **forced override** for its key only, and the settings GET answers which side won | Unset — the stored value or the default applies. Clamped to 10–3600; non-integer values are ignored |
