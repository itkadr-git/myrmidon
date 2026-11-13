# 1.7 COMPANY-BOUNDARIES: инвентаризация сущностей BBQ/Work/Life (OPE-12764)

Дата: 2026-11-12. Метод: dry-run probe (read-only GET) по live-доске + анализ схемы/API в репозитории.
Инструмент: `scripts/myrmidon/company-boundaries-inventory.mjs` (добавлен этой задачей). Он обходит задачи постранично (`limit=500`, `offset`) до конца, а недоступные board-only поверхности фиксирует как явные findings, а не выдаёт их за пустые.
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
| Agent configurations / per-agent skills/instructions | запрашиваются как optional redacted/bulk surfaces; при отсутствии — explicit warning | `/agent-configurations`, `/agent-skills-and-instructions` | зависит от board scope |
| Память / corpus | optional surface; профильная память не считается пустой при 403/404 | `/memory` | зависит от runtime |
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

## Покрытие по секциям инвентаря (coverage state, OPE-12874)

Состояние покрытия приведено в соответствие с фактическими результатами probe
(read-only GET, live-замер 2026-11-12). Три состояния: `covered` — секция
получена целиком; `partial` — секция получена частично (есть источник, но он
неполный, либо покрытие достигается через обходной metadata-only путь);
`unavailable` — источник недоступен с использованным ключом (403/404/нет
маршрута) и НЕ объявлен покрытым. Машино-читаемая версия этой таблицы —
fixture `scripts/myrmidon/fixtures/company-boundaries-inventory-coverage.json`;
тест `scripts/myrmidon/company-boundaries-inventory-coverage.test.mjs` проверяет,
что таблица ниже и fixture не расходятся (имя файла отлично от
`company-boundaries-inventory.test.mjs` behavioral-пакета probe: тот живёт в
ветке probe-скрипта, здесь — docs-only проверка отчёта).

| Секция | Источник (endpoint/export) | Coverage state | Основание |
|---|---|---|---|
| agents | `GET /agents` | covered | 81 агент, agent-ключ ок |
| org | вывод из `/agents` (`reportsTo`) | partial | отдельного export орг-дерева нет; дерево выводится из агентских записей |
| projects | `GET /projects` | covered | 12 проектов |
| issues | `GET /issues?view=compact` (paginated `limit=500&offset`) | partial | compact-вид с cap; полные описания/комментарии не выгружаются |
| agentConfigurations | `GET /agent-configurations` | unavailable | redacted metadata зависит от board scope; per-agent инструкции не материализуются |
| agentSkillsAndInstructions | `GET /agent-skills-and-instructions` | unavailable | bulk-export surface недоступен (нет маршрута/scope) |
| memory | `GET /memory` + per-agent `GET /api/myrmidon/agents/:id/memory` (status-only, OPE-12862) | partial | company-level `/memory` недоступен; per-agent статус-only проверка даёт covered-empty/covered-nonempty/unavailable, содержимое не читается |
| skills | `GET /skills` | covered | 127 skills |
| skillFolders | `GET /folders?kind=skill` | covered | 9 папок, unfiled 106 |
| routineFolders | `GET /folders?kind=routine` | covered | 0 папок, unfiled 30 |
| routines | `GET /routines` | covered | 30 (active 17, paused 9, archived 4) |
| goals | `GET /goals` | covered | 0 (empty, покрыто подтверждённо) |
| cases | `GET /cases` | covered | 0 (empty, покрыто подтверждённо) |
| secretsCatalog | `GET /secrets/catalog` | covered | 454 активных; только метаданные, значения не запрашивались |
| secretProviderConfigs | `GET /secret-provider-configs` | unavailable | board-only (403 с agent-ключа) |
| secretBindings | `GET /secret-bindings` | unavailable | 404 — нет REST-маршрута (`company_secret_bindings` живёт в БД/export) |
| budgetsOverview | `GET /budgets/overview` | covered | 39 policy |
| costsSummary | `GET /costs/summary` | covered | spend $9 945.63 / forecast $11 929.23 |
| aiConnections | `GET /ai-connections` | unavailable | 403 board_access_required |
| chatEndpoints | `GET /chat-endpoints` | unavailable | 403 board_access_required |
| exportFidelity | `GET /export/fidelity` | unavailable | 403 board_access_required |

### Owner attribution

Атрибуция владельца берётся только из явных полей (`metadata.forkedByAgentId`,
затем `metadata.forkedByUserId` для skills — OPE-12871/OPE-12872); `authorName`,
внешние GitHub/skills.sh `metadata.owner` — provenance, не владение. Везде,
где явного владельца нет, ставится `unknown` (не угадывается):

- 6 корневых агентов без `reportsTo`: владелец домена `unknown` для
  `Wiki Maintainer` и `Персональный бот: ключ модели` (не lead-роли);
  intended-лидеры фиксируются перед пилотом (finding `agents_without_leader`).
- bundled-skills (system-папки): владелец `unknown` на уровне домена —
  атрибуция только «компания».
- секции со state `unavailable` не имеют атрибуции владельца в этом отчёте
  (данные не получены), это `unknown`, а не «без владельца».

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

Память в Myrmidon привязана к профилю агента (profile `memories/`, session_search,
knowledge corpus) и следует за агентом, а не за компанией — см. `doc/memory-landscape.md`.
В probe (секция `memoryCoverage`, OPE-12862) используется только metadata-only проверка
per-agent статуса (`GET /api/myrmidon/agents/:id/memory` без чтения текстов памяти) со
строгой трёхуровневой моделью:
- `covered-empty` — агент подтверждён (HTTP 200), memory bank отсутствует (`bank: null` / `reason: no_bank`) или память отключена (`enabled: false`);
- `covered-nonempty` — агент подтверждён (HTTP 200) и присутствует явный идентификатор банка (`bankId`), само содержимое памяти не запрашивается и отбрасывается allowlist-ом;
- `unavailable` — источник недоступен (`403`, `404`, сетевая ошибка, некорректный payload); отсутствие эндпоинта или 403 никогда не маскируется под `covered-empty` и фиксируется finding `memory_coverage_incomplete`.

Для пилота: убедиться, что копия профиля Life-агентов переносится с ними; corporate
knowledge-корпус остаётся в ADM-компании.

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

## Воспроизведение

```
node scripts/myrmidon/company-boundaries-inventory.mjs probe \
  --company <uuid> --url <api-base> --key-env PAPERCLIP_API_KEY --out before.json
node scripts/myrmidon/company-boundaries-inventory.mjs probe \
  --company <uuid> --url <api-base> --key-env PAPERCLIP_API_KEY --out after.json
node scripts/myrmidon/company-boundaries-inventory.mjs diff --before before.json --after after.json
```

## Пакет тестирования

OPE-12874 (docs/tests only): `node --test scripts/myrmidon/company-boundaries-inventory-coverage.test.mjs`
проверяет, что таблица покрытия «Покрытие по секциям инвентаря» выше и fixture
`scripts/myrmidon/fixtures/company-boundaries-inventory-coverage.json` не
расходятся: для каждой секции совпадают endpoint/export-источник, coverage
state (`covered`/`partial`/`unavailable`), число секций и явные `unknown`-атрибуции
владельца; ни одна `unavailable`-секция не объявлена покрытой.

Полный behavioral-пакет probe (parseArgs, redact, memoryCoverageStatusFor /
probeMemoryCoverage, summarizers, findings, diff, SECTIONS-покрытие, exit-коды) —
в ветке probe-скрипта; здесь он не воспроизводится, потому что сам probe-модуль
в main пока не влит. В CI прогоняется автоматически
(`scripts/myrmidon/*.test.mjs` через node --test).
