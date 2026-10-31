## divergence-new

<!-- after: 1.6.2 — RUN-ADMISSION: допуск прогонов по свободной памяти хоста и плавный старт -->

### 1.6 — GUARDRAILS A: детекторы утечек на выходе (только флаг)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6-GRD | Паттерн-ориентированные детекторы секретов и ПДн на финальном тексте прогона, режим «только флаг»: срабатывание пишет событие, текст не меняется и не блокируется. Новый модуль `server/src/myrmidon/guardrails/` (`detect.ts` — чистые функции: формы ключей OpenAI/Anthropic, `ghp_`/`gho_`, AKIA, `xoxb-`, bearer JWT, `pcp_`; ПДн: e-mail, телефоны, карты Luhn, СНИЛС и ИНН 10/12 с контрольной суммой; `events.ts` — журнал + публичный замороженный контракт `recordGuardrailEvent(db, {companyId, issueId, runId, kind, surface, severity, snippet, occurredAt})` для части B; `routes.ts` — read-only маршрут; `run-output.ts` — хук встраивания). Таблица `guardrail_events` (company-scoped, kind/surface/severity/run_id/issue_id/snippet-уже-маскированный/occurred_at, аддитивная миграция) + строка в `activity_log` на каждое событие. Сниппет вырезается из текста, прошедшего существующее маскирование S5, и маскируется повторно при записи. Настройки в модуле, не в config.ts: `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED` (по умолчанию выкл, включается при выкате) и `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` (csv, мусор откатывается ко всем категориям) | Наши файлы: `packages/db/src/schema/guardrail_events.ts`, `server/src/myrmidon/guardrails/{detect,events,routes,run-output,index}.ts`, тесты `server/src/myrmidon/guardrails/{detect,events,run-output}.myrmidon.test.ts`, миграция `packages/db/src/migrations/0296_*.sql` + meta, доки `docs/myrmidon/SETTINGS.md` и `SETTINGS.ru.md` (подсекция GUARDRAILS A). В вендоре помечены `myrmidon(1.6-GRD)`: `packages/db/src/schema/index.ts` (экспорт таблицы), `server/src/app.ts` (импорт + одна строка `api.use`), `server/src/services/heartbeat.ts` (импорт + один вызов `guardrailsOnRunOutput` перед созданием комментария прогона, за маркером; ошибки глотаются) | План 1.6.1: утечки секретов и ПДн в видимый вывод должны быть видимы оператору до включения блокирующих режимов (1.5); вендорского детекторного слоя нет | `server/src/myrmidon/guardrails/detect.myrmidon.test.ts` (формы секретов, ПДн с контрольными суммами, агрегат, перекрытия, фильтр категорий, сниппет), `events.myrmidon.test.ts` (замороженный контракт, маскировка сниппета, список журнал + маршрут: 401/403/200, лимит; скан выхода: выкл/вкл/csv/глотание ошибок), `run-output.myrmidon.test.ts` (интеграция встраивания: событие в БД со всеми полями, тишина при выключенном свиче, чистый вывод, null-текст) | Никогда, наше поведение (базовый слой GUARDRAILS). При переносе: сохранять модуль `guardrails/`, таблицу `guardrail_events` (аддитивная миграция не снимается), строки монтирования с меткой `myrmidon(1.6-GRD)`; блокирующие режимы и UI-настройка — план 1.5 | (этот PR) |

### 1.7 — GUARDRAILS MODES: режимы принуждения по правилу (блок / маскирование / только флаг)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-GRD-MODES | Режимы принуждения для каждого правила ограждений 1.6.1 (`secret`, `pii` на выходе; `injection` на входе): `flag` (умолчание — журнал, ничего не меняет), `mask` (замена совпавших фрагментов нейтральным заполнителем), `block` (отказ: ответ прогона заменяется текстом-отказом на языке оператора — правило, число срабатываний, уровень задания режима; совпавшие значения не раскрываются). Наследование агент > каста (роль агента) > компания > умолчание `flag`; env `MYRMIDON_GUARDRAILS_MODE_FORCE` — только аварийное принуждение оператором (валидное значение: `flag`/`mask`/`block`; опечатка = без принуждения). Настройки в `instance_settings.general.guardrailModes` (механизм как WIP-LIMIT, без миграции), строгая zod-схема (`z.partialRecord`): неизвестные ключи/режимы — 400. Перечитывается при каждом срабатывании — смена режима касты действует на следующий ответ агента без перезапуска (критерий приёмки плана 1.7). Исполнение: `run-output.ts` резолвит режим ДО записи событий (severity: block=error, mask=warn, flag=info) и возвращает enforcement-решение (text), heartbeat пишет решение как комментарий; injection — в `queued-comment-use-cases.ts`: block сохраняет комментарий, но payload прогона несёт обёртку-отказ, mask подменяет текст в `<untrusted-data>`. Экран `Настройки компании → Guardrails` (текущий UI): матрица правил×уровней, колонка эффективного режима с источником (резолв с сервера через `resolve?agentId=`), журнал с фильтрами kind/severity/runId. Точка входа БД-настроек fail-open: сбой чтения = `flag`, прогон не ломается | Наши файлы: `packages/shared/src/myrmidon-guardrail-modes.ts` (+тест) — модель/резолвер/env-ключ, экспорт из `packages/shared/src/index.ts`; `server/src/myrmidon/guardrails/{modes,modes-settings}.ts` (+`modes.myrmidon.test.ts`, `routes-modes.myrmidon.test.ts`) — загрузка из БД, маскирование, текст отказа, чтение/запись настроек; UI `ui/src/components/myrmidon/guardrails/{guardrailsApi,GuardrailsScreen,GuardrailsScreenContainer,GuardrailsJournal}.tsx` (+3 теста), словарь в `ui/src/i18n/myrmidon-locales/{en,ru}.json`; доки `docs/myrmidon/guides/guardrail-modes{.ru,}.md` + строки в SETTINGS/SETTINGS.ru. Вендор помечен `// myrmidon(1.7-GRD-MODES)`: `server/src/services/heartbeat.ts` (комментарий прогона = решение гвард-рейла), `server/src/modules/wake-queue/application/queued-comment-use-cases.ts` (injection-режимы) и `index.ts` (прокинут резолвер), `server/src/services/instance-settings.ts` (normalize + preserve ключа `guardrailModes`), `server/src/myrmidon/guardrails/{events,run-output,routes,index}.ts` (наши файлы слоя 1.6.1, расширены маркером 1.7), `packages/shared/src/{validators,types}/instance.ts` (поле `guardrailModes` в general), `ui/src/App.tsx` (роут) и `ui/src/components/access/CompanySettingsNav.tsx` (пункт навигации + i18n) | План 1.7 GUARDRAILS MODES: базовый слой 1.6.1 был только-флаг; релизу 1.7 нужны режимы блок/маскирование, настраиваемые в интерфейсе по гнезду/касте/агенту и действующие без перезапуска; политику инструментов по матрице автономии делает 1.6.2 — не дублируется | `packages/shared/src/myrmidon-guardrail-modes.test.ts` (11: наследование по всем уровням, env-принуждение и опечатки, строгая схема, умолчание flag), `server/src/myrmidon/guardrails/modes.myrmidon.test.ts` (12, embedded-PG: смена режима касты действует на следующее решение — приёмка; умолчание flag — приёмка; блок/маскирование текстов; сбой чтения = fail-open), `routes-modes.myrmidon.test.ts` (9: GET/PUT настроек, resolve по агенту, фильтры журнала, 400 на мусор, доступность), `queued-comment-guardrails.myrmidon.test.ts` расширено (injection block/mask/flag: payload несёт отказ/замену/флаг), UI: GuardrailsScreen (7), GuardrailsJournal (4), GuardrailsScreenContainer (3), расширены CompanySettingsNav и myrmidon-i18n | Никогда, наше поведение (продолжение базового слоя GUARDRAILS). При переносе: сохранять `myrmidon-guardrail-modes.ts` в shared, `modes*` в guardrails/, поле `guardrailModes` в general (preserve в instance-settings), экран/роут/словарь в UI; env-ключ `MYRMIDON_GUARDRAILS_MODE_FORCE` — аварийный, оставить | (этот PR) |

## settings-en-new

<!-- after: 1.7 — BUDGET-CONFIG B: enforcement mode of spend limits -->

### 1.6 — GUARDRAILS A (output leak detectors, flag-only)

Settings of the module `server/src/myrmidon/guardrails/` (the 1.6.1 guardrail base layer:
pattern-oriented detectors for secrets and personal data in a run's final output, plus a
company-scoped `guardrail_events` journal and a read-only board route). 1.6.1 is flag-only: a hit
records an event, nothing is blocked and no text is masked by this layer — the existing value-based
masking (S5) keeps doing the masking. The snippet stored in the journal is cut from text that
already passed through that masking. Legal-entity requisites (INN/KPP/BIC-like requisites beyond
the checksum detectors) are backlog and not part of this layer.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED` | GUARDRAILS-A | unset (off) | Master switch of the output scan. The final run text is scanned once at run finalization, before it becomes the visible issue comment. Only the exact values `1` or `true` enable it — rollout turns it on explicitly | Any other value (or unset) — no scan runs, no events are recorded, the run output is untouched. A typo does not silently turn the layer on |
| `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` | GUARDRAILS-A | unset (both) | Which detector categories run, as a csv of `secret`, `pii` (e.g. `secret` or `secret,pii`) | Empty/unset — all categories. Unknown or misspelled entries fall back to ALL categories (misconfiguration must not silently disable a detector), the list is lower-cased and trimmed |

The detectors recognize: OpenAI/Anthropic key shapes, GitHub `ghp_`/`gho_` tokens, AWS `AKIA`
access-key ids, Slack `xoxb-` bot tokens, bearer JWTs, `pcp_`-prefixed tokens (secrets); e-mail,
phone numbers, payment cards (Luhn), SNILS and INN 10/12 (checksum, pii). Each event row carries
kind, surface (`run_output`), severity, run id, issue id, a masked snippet and `occurred_at`, plus
an `activity_log` line. The journal is read at
`GET /api/myrmidon/companies/:companyId/guardrails/events?limit` (company access, newest first,
limit capped at 200, default 50). Part B (prompt-injection input flags) writes events through the
same `recordGuardrailEvent` contract.

### 1.7 — GUARDRAILS MODES (per-rule enforcement modes: block / mask / flag)

Behavior settings of the guardrail mode layer (`docs/myrmidon/guides/guardrail-modes.md`).
The modes are configured in the board UI at `Company Settings → Guardrails` and stored in
`instance_settings.general.guardrailModes` — no restart, a change applies to the next answer of
the affected agent. Resolution order: agent > caste (role) > company > `flag` (default).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_GUARDRAILS_MODE_FORCE` | GUARDRAILS-MODES | unset (no force) | Operator-only emergency lever: forces one mode (`flag`, `mask`, `block`) for every rule and every agent, overriding the UI settings at all levels | Any other value (or unset/blank) — no force, the UI settings decide. A typo never silently rewrites the blocking policy. This is the only env variable of the feature; everything else is UI-configurable |

## settings-ru-new

<!-- after: 1.6.1 — VOICE-STT (серверное ядро распознавания речи, часть A) -->

### 1.6 — GUARDRAILS A (детекторы утечек на выходе, только флаг)

Настройки модуля `server/src/myrmidon/guardrails/` (базовый слой ограждений 1.6.1:
паттерн-ориентированные детекторы секретов и ПДн в финальном тексте прогона плюс
журнал срабатываний `guardrail_events` в рамках компании и один read-only маршрут).
1.6.1 — режим «только флаг»: срабатывание пишет событие, ничего не блокируется и
текст этим слоем не маскируется — маскирование продолжает делать существующее
значение-ориентированное маскирование (S5). Сниппет в журнале вырезается из текста,
который уже прошёл через это маскирование. Реквизиты юрлиц — backlog, в слой не входят.

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенность |
|---|---|---|---|---|
| `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED` | GUARDRAILS-A | не задано (выкл) | Главный выключатель сканирования выхода. Финальный текст прогона сканируется один раз при финализации, до того как стать видимым комментарием задачи. Включают только точные значения `1` или `true` — включение происходит явно при выкате | Любое другое значение (или не задано) — скан не запускается, событий нет, выход прогона не меняется. Опечатка не включает слой молча |
| `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` | GUARDRAILS-A | не задано (обе) | Какие категории детекторов запускаются, csv из `secret`, `pii` (например `secret` или `secret,pii`) | Пусто/не задано — все категории. Неизвестные или с опечаткой значения откатываются ко ВСЕМ категориям (ошибка настройки не должна молча выключать детектор), список приводится к нижнему регистру и обрезается по пробелам |

Детекторы распознают: формы ключей OpenAI/Anthropic, токены GitHub `ghp_`/`gho_`,
идентификаторы `AKIA` AWS, бот-токены Slack `xoxb-`, bearer JWT, токены с префиксом
`pcp_` (секреты); e-mail, телефоны, платёжные карты (Luhn), СНИЛС и ИНН 10/12
(контрольная сумма, ПДн). Каждая запись события несёт kind, surface (`run_output`),
severity, id прогона, id задачи, маскированный сниппет и `occurred_at`, плюс строку
в `activity_log`. Журнал читается через
`GET /api/myrmidon/companies/:companyId/guardrails/events?limit` (доступ компании,
сначала новые, лимит не выше 200, умолчание 50). Часть B (флаги инъекций на входе)
пишет события через тот же контракт `recordGuardrailEvent`.

### 1.7 — GUARDRAILS MODES (режимы принуждения по правилу: блок / маскирование / только флаг)

Настройки поведения слоя режимов ограждений (`docs/myrmidon/guides/guardrail-modes.ru.md`).
Режимы настраиваются в интерфейсе доски: «Настройки компании → Guardrails», хранятся в
`instance_settings.general.guardrailModes` — без перезапуска, смена действует на следующий
ответ затронутого агента. Порядок наследования: агент > каста (роль) > компания > `flag`
(умолчание).

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенность |
|---|---|---|---|---|
| `MYRMIDON_GUARDRAILS_MODE_FORCE` | GUARDRAILS-MODES | не задано (без принуждения) | Аварийный рычаг оператора: принудительно включает один режим (`flag`, `mask`, `block`) для всех правил и всех агентов, перекрывая настройки интерфейса на всех уровнях | Любое другое значение (или не задано/пусто) — принуждения нет, решают настройки из интерфейса. Опечатка не переписывает молча политику блокировки. Единственная переменная окружения фичи; всё остальное настраивается в интерфейсе |
