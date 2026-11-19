# 1.7 COMPANY-BOUNDARIES: инвентаризация сущностей BBQ/Work/Life (OPE-12764)

Дата: 2026-11-12. Метод: dry-run probe (read-only GET) по live-доске + анализ схемы/API в репозитории.
Инструмент: `scripts/myrmidon/company-boundaries-inventory.mjs` (добавлен этой задачей). Он обходит задачи постранично (`limit=500`, `offset`) до конца, а недоступные board-only поверхности фиксирует как явные findings, а не выдаёт их за пустые.
Память и knowledge corpus включены как полноценные секции probe (не проза): `agentMemory`
(per-agent `GET /api/myrmidon/agents/:id/memory` — только `enabled`/`bank.bankId`/`bank.source`/`reason`;
`/memory/memories` и `/memory/export` не вызываются — export пишет audit-строку и нарушает
read-only контракт), `corpusDatasets` (`GET /api/myrmidon/companies/:companyId/corpus/datasets` —
id/name + счётчики документов) и `corpusStats` (`GET .../corpus/stats` — только агрегаты).
Содержимое документов и чанков corpus не запрашивается никогда.
Компания: `2870b911-483a-4091-9f15-183841811143` — единственная компания доски, все домены
(BBQ / Work / Life / ADM) пока живут в ней. Разделение ещё не выполнено — эта карта фиксирует
состояние «до».

## Метод и гарантии dry-run

- Все обращения — GET (probe ничего не создаёт, не меняет и не удаляет).
- Значения секретов не запрашиваются и не выводятся: вызывается только
  `GET /secrets/catalog` (возвращает id/name/key/status); маршруты с plaintext
  (`/secrets` values, `company_secret_versions.material`, proposals ciphertext) не вызываются.
  Дополнительная защита: `redact()` вырезает value-поля из любого попавшего в отчёт payload.
- Токен передаётся через переменную окружения (`--key-env ИМЯ`), в командной строке,
  отчёте и логах не появляется.
- Идемпотентность проверена live: два последовательных прогона + `diff` —
  расхождения только живой активности (status running→idle, тик spend-счётчиков),
  которые исключены из content-hash (`VOLATILE_KEYS`).
- Exit codes: 0 — чисто; 1 — есть error-grade findings (гейт для пилота); 2 — ошибка вызова.

## Сводка сущностей (live-замер 2026-11-12)

| Сущность | Кол-во | Источник | Доступность с agent-ключом |
|---|---|---|---|
| Агенты | 81 | `/agents` | ок |
| Проекты | 12 | `/projects` | ок |
| Задачи | полный постраничный обход (`limit=500`, `offset`) | `/issues?view=compact` | ок |
| Agent configurations / per-agent skills/instructions | 81 агентов опрошены по каждому; часть агентов отвечает 403 config-read — explicit warning | `/api/agents/:id/configuration`, `/api/agents/:id/skills`, `/api/agents/:id/instructions-bundle` | частично (per-agent gate) |
| Память (agent memory banks) | 81 опрошено, 0 прочитано с agent-ключа — 403 board_access_required на всех; фиксируется как `agentMemory_unavailable` (не «памяти нет») | `/api/myrmidon/agents/:id/memory` (board-only) | 403 board_access_required |
| Knowledge corpus | 11 датасетов, 1489 документов (ready 1489 / failed 0), 285 814 чанков, ~10.99 ГБ; крупнейший `bbq-craft` 509 док. — собственность BBQ-домена внутри общей компании | `/api/myrmidon/companies/:companyId/corpus/datasets`, `.../corpus/stats` | ок (company scope) |
| Профильная память (Hermes `memories/`, session_search SQLite) | REST-API на доске нет — зафиксировано как граница покрытия; переносится с контейнером профиля агента | — (вне API доски) | вне API |
| Skills | 127 | `/skills` | ок |
| Skill-папки | 9 папок, unfiled 106 | `/folders?kind=skill` | ок |
| Routine-папки | 0 папок, unfiled 30 | `/folders?kind=routine` | ок |
| Routines | 30 (active 17, paused 9, archived 4) | `/routines` | ок |
| Goals / Cases | 0 / 0 | `/goals`, `/cases` | ок |
| Секреты (метаданные) | 454 активных | `/secrets/catalog` | ок (только метаданные) |
| Secret provider configs / bindings | optional metadata-only surfaces; credentials/ciphertext never requested | `/secret-provider-configs`, `/secret-bindings` | board-only / route-dependent |
| Бюджетные policy | 39 | `/budgets/overview` | ок |
| Cost summary | spend $9 945.63 / forecast $11 929.23 | `/costs/summary` | ок |
| AI connections | — | `/ai-connections` | 403 board_access_required |
| Chat endpoints | — | `/chat-endpoints` | 403 board_access_required |
| Export fidelity | — | `/export/fidelity` | 403 board_access_required |

## Агенты (81) и структура подчинения

Корни (reportsTo=null): 6 — `work` [lead], `life` [general], `bbq` [lead],
`adm` [lead], `Wiki Maintainer` [knowledge-maintainer, paused],
`Персональный бот: ключ модели` [general].

Поддеревья: BBQ — 25 агентов, Work — 13, ADM — 40, одиночные (life, Wiki Maintainer,
Персональный бот) — 3. Итого 81.

Роли: engineer 17, lead 12, infra 8, editor 7, reviewer 6, analyst 6, operator 4, qa 4,
smm 3, copywriter 2, designer 2, finance 2, general 2, architect/lawyer/knowledge-maintainer/
security/support/release — по 1.

Адаптеры: hermes_gateway 71, omp_local 7, openclaw_gateway 1, claude_local 1, process 1.

Лидеры с прямыми подчинёнными: 17. Агентов с отчётом на отсутствующий в компании id: 0.
Бюджет: 1 агент с лимитом (`Персональный бот: ключ модели`, 2000 центов/мес) — это кандидат
на якорь пилота Life. Суммарный расход за месяц по агентам: $4 772.11 (тик в реальном времени).

## Проекты (12)

- BBQ: «Магазин: сайт и каталог», «Реклама, SEO и аналитика», «Соцсети» (лид bbq).
- Work: «Деловые проекты» (лид work).
- Life: «Личное» (лид life).
- ADM: «ADM — личные задачи (Claude Code)», «Инфраструктура и надёжность»,
  «Организация агентов», «Переезд с fn02» (completed) — лиды adm-агенты.
- Cross/без лида: «LLM Wiki», «Разработка инструментов» (лид adm-dev-инфра агент),
  «Идеи» (backlog).

Статусы: active 7, in_progress 3, completed 1, backlog 1. С лидом 9 из 12.

## Задачи

В выборке compact (cap 200): открытых 9, без исполнителя 10.
Распределение по проектам: «Разработка инструментов» 117, без проекта 69,
«Инфраструктура и надёжность» 13, «ADM — личные задачи» 1.
Статусы: done 189, in_progress 4→3 (live), todo 1→2 (live), blocked 2, backlog 2, cancelled 2.
10 задач без исполнителя — риск: автоназначение после разделения не должно выбирать
агентов чужих компаний (finding `issues_unassigned`).

## Skills / instructions (127)

trust: markdown_only 103, assets 13, scripts_executables 11.
Источник: local_path 102, catalog 21, url 3, well_known 1.
Cross-company сигналы чистые: shared вне компании — 0, forked из другой компании — 0.

Папки: system `bundled` (Paperclip Core 11, Paperclip Operations 5, Quality 1, Docs 1,
Product 2, Software Development 1), `My Skills` (OpenClaw Admin), unfiled 106.
Routines без папок: 30 (все с исполнителем).

Per-agent instructions/skills живут в `agent.runtimeConfig`/`metadata` — в этой карте не
раскрываются поагентно; перед пилотом выгрузить per-agent skill-наборы detail-эндпоинтом.

## Секреты (только метаданные; значения не читались)

Каталог: 454 активных записей. Префиксы (топ): `myrmidon-bot-*` 210 (ключи ботов — по
агенту, переносятся вместе с агентом), `litellm-key-*` 103 (общий пул моделей — ADM),
`ops-ssh-*` 12, `chat-telegram-*` 8 + `telegram-bot-*` 2 (BBQ-каналы), `shop-ssh-*` 8
(BBQ-магазин), `environment-ssh-*` 7 (инфраструктура рантаймов — ADM),
`hermes-sandbox-*` 4, `model-provider-*` 4 (ADM), `github-app-*` 2 + `github-token-*` 2
(ADM/инженерия), `google-ai-*` 2, `mcp-grafana-*` 2, `myrmidon-site-*` 2,
`adm-bw-*`, `adm-host-*`, `adm-paperclip-*`, `antigravity-pool-*`, `api-ro-*`, `chatgpt-pool-*` по 1.

Привязки (bindings) секретов к агентам/каналам в catalog не видны — для пилота нужен
board-ключ (схема: `company_secret_bindings`, `company_secret_provider_configs`).

## Бюджеты и деньги

39 policy, все scopeType=agent, метрика billed_cents; активна 1
(Персональный бот: ключ модели — Life-домен); hard_stop у 34.
Сумма лимитов 2000 центов; наблюдаемый расход по окнам 71593 цента.
Costs: spend $9 945.63, forecast $11 929.23, budgetCents 0 (компания без общего лимита).
Расхождение учёта: unpricedEvents 63 108, unpricedTokens 77.9 млрд — при разделении
компаний атрибуция затрат станет слепой зоной, чинить до пилота.

## Память

Серверная память (Hindsight banks) опрашивается секцией `agentMemory` — маршрут
`GET /api/myrmidon/agents/:id/memory` отвечает только метаданными (`enabled`,
`bank.bankId`, `bank.source` ∈ agent-card|plugin-config, `reason`), сами записи памяти
и экспорт не читаются (probe не вызывает `/memory/memories` и `/memory/export`; export
пишет audit-строку, что нарушило бы read-only контракт dry-run). Замер с agent-ключа
этого прогона: 81/81 агентов → 403 board_access_required → секция честно помечена
`available: false, reason: board_access_required` и finding `agentMemory_unavailable`;
вывод «у агентов нет памяти» из этого не делается. Для полной карты банков нужен
board-ключ (см. «Расхождения»).

Corpus-секция замерена live: 11 датасетов knowledge-корпуса в общей компании
(1489 документов, все ready, 285 814 чанков, ~10.99 ГБ). Владение по доменам видно из
имен: `bbq-craft` 509 док. / 178 837 чанков — контент BBQ; `work-craft` 179 / 37 327 —
Work; `adm-craft` 126 / 58 759 — ADM; `stack-docs`, `paperclip-docs`, `platform-docs`,
`litellm-docs`, `prompt-engineering`, `fleet-tools`, `stack-docs-2026-09`,
`acceptance-fixture-0611` — инфраструктурные/общие (владелец ADM). На пилоте Life
датасеты нужно разделять по компаниям (finding `corpus_datasets_present`); документы
и чанки при инвентаризации не читались — только счётчики.

Память профиля Hermes (`memories/` каталог профиля, session_search SQLite) за пределами
API доски — это граница покрытия карты: она следует за контейнером агента, см.
`doc/memory-landscape.md`. Для пилота: копия профиля Life-агентов переносится с ними;
corporate knowledge-корпус остаётся в ADM-компании.

## Зависимости с ADM и владельцы

| Домен | Владелец (корневой агент) | Зависимости с ADM / общие объекты |
|---|---|---|
| BBQ | `bbq` (6e7cda55, lead) | bundled-skills компании, litellm-пул, инфра hermes; telegram- и shop-секреты свои |
| Work | `work` (10890d3d, lead) | bundled-skills, litellm-пул, общая модельная инфраструктура |
| Life | `life` (4b339d18) + «Персональный бот: ключ модели» (единственный активный бюджет) | модельный ключ через общий provider; bundled-skills |
| ADM | `adm` (b018f9bf, lead) | доска Paperclip, GitHub, ops/environment-ssh, model-provider, github-секреты — всё остаётся в ADM |

Владельцы общих объектов: bundled-skills — компания (system-папки), litellm-key-пул и
model-provider — ADM, myrmidon-bot-* — индивидуальные по агентам, телеграм/шоп — BBQ.

## Расхождения и риски перед пилотом Life

1. `secretsCatalog` без bindings — полный перечень переносимых секретов требует board-ключа.
2. `ai-connections`, `chat-endpoints`, `export/fidelity` — 403 с agent-ключа; перезапустить
   probe с board-ключом перед пилотом (script это фиксирует как warning-findings).
3. 6 корней без лидера — после разделения зафиксировать intended-лидеров (finding
   `agents_without_leader`).
4. 10 задач без исполнителя — запретить cross-company автоназначение.
5. Персональный бот: ключ модели — единственная активная бюджетная policy и единственный
   агент с лимитом; якорь Life-пилота, мигрировать первым.
6. Unpriced events/tokens — восстановить атрибуцию затрат до разъезда.
7. Карта банков памяти неполна: `agentMemory` требует board-ключа (81/81 → 403 board_access_required
   с agent-ключа этого прогона). Перезапустить probe с board-ключом — секция наполнится
   (`enabled`/`bank.bankId`/`bank.source`), и finding `agentMemory_unavailable` уйдёт.
8. Knowledge-corpus датасеты (11 шт., 1489 док., 285 814 чанков) лежат в одной общей компании,
   доменная принадлежность видна только из имён (`bbq-craft`, `work-craft`, `adm-craft`) —
   перед пилотом разделить датасеты по компаниям; остальное (stack/paperclip/platform/litellm
   docs) — общий ADM-слой.

## Воспроизведение

```
node scripts/myrmidon/company-boundaries-inventory.mjs probe \
  --company <uuid> --url <api-base> --key-env PAPERCLIP_API_KEY --out before.json
node scripts/myrmidon/company-boundaries-inventory.mjs probe \
  --company <uuid> --url <api-base> --key-env PAPERCLIP_API_KEY --out after.json
node scripts/myrmidon/company-boundaries-inventory.mjs diff --before before.json --after after.json
```

## Пакет тестирования

`node --test scripts/myrmidon/company-boundaries-inventory.test.mjs` — 45 тестов
(parseArgs, redact, все summarizers включая memory/corpus, findings, diff, SECTIONS-покрытие
с защитой от content-поверхностей, exit-коды; плюс портированное из main #3032 покрытие
состояний transient-error: транспортный сбой на обязательной секции роняет прогон громко,
на опциональной — деградирует в явный unavailable-warning без скрытого ретрая, повторный
прогон по стабильной поверхности покрывает секцию). В CI прогоняется автоматически
(`scripts/myrmidon/*.test.mjs` через node --test).
