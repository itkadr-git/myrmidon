---
divergence-section: 1.6.1 — STALE-BLOCK, часть B: сторож-sweep мёртвых блоков
---

## changelog-en

### docs: custom castes (CUSTOM-CASTES A) — the company agent-role directory

- A new guide (EN+RU) describing the agent_castes directory: the fields of a caste, the twelve seeded built-ins, the REST contract under /api/myrmidon/companies/:id/castes including the DELETE reassignTo flow, and live reads with no restart.
- SETTINGS.md/SETTINGS.ru.md gain the 1.6.1 — CUSTOM-CASTES A section next to the existing consumers section (with the stale 'until part A lands' sentence fixed), the guides table points at the new guide, and the wiki settings page mentions the Agent castes screen.

## changelog-ru

### docs: custom castes (CUSTOM-CASTES A) — справочник каст компании

- Новый гайд (EN+RU) про справочник agent_castes: поля касты, двенадцать встроенных каст при первом чтении, REST-контракт /api/myrmidon/companies/:id/castes включая DELETE с reassignTo, живое чтение без перезапуска.
- SETTINGS.md/SETTINGS.ru.md получают секцию 1.6.1 — CUSTOM-CASTES A рядом с существующей секцией consumers (с исправленной устаревшей фразой 'until part A lands'), таблица гайдов указывает на новый гайд, вики-страница настроек упоминает экран Agent castes.

## settings-en-new

<!-- after: 1.6 — PARALLEL-HELPERS (delegated helper agents) -->
### 1.6.1 — CUSTOM-CASTES A: the company caste (agent role) directory

The directory behind the feature: a per-company table (`agent_castes`,
migration `0304_agent_castes.sql` — additive only, one new table with its
indexes, no existing data rewritten) that replaces the fixed list of twelve
agent roles with company-owned castes. The board UI carries it as the
"Agent castes" screen in company settings; the user-facing walkthrough is
[guides/custom-castes.md](guides/custom-castes.md).

The directory adds no environment variables: rows live in the table and are
read from the database on every request (no process cache), so create, edit,
and delete are visible to the swarm and to every client without a restart.
The first read of a company seeds the twelve built-in castes (idempotently —
only the missing keys are inserted), marking them `builtIn: true`; agents
already on the board keep their roles untouched.

A caste carries: `key` (the stable identifier, latin letters, digits, hyphens
and underscores, 1–60 characters, lowercased — the exact string stored in
`agents.role`; immutable), `nameEn` (required) and `nameRu`, `description`,
`color` from the status palette (`primary`, `muted`, `blue`, `amber`,
`green`, `violet`, `red`, `gray`; default `gray`), `icon`, `defaultModel`,
`swarmEligible` (default `true`), `maxActiveTasks` (1–1000 or `null` for the
global swarm ceiling), and the immutable `builtIn` flag.

REST API (`server/src/myrmidon/castes/`): `GET/POST
/api/myrmidon/companies/:companyId/castes` and `PATCH/DELETE
.../castes/:key`. Reads need company access; mutations are board-only, and
another company gets a 403 on every route. POST answers `201` (duplicate key
— `409`); PATCH answers `200` and rejects `key`/`builtIn` in the body with a
`400`; DELETE answers `204`. A caste with agents still on it needs
`{"reassignTo": "<key>"}` in the DELETE body — without it the answer is a
`409` (`caste_has_agents`); with it the agents move to the target caste and
the row is deleted in one transaction, and their queued tasks follow because
the swarm queues are built from `agents.role`. Error bodies carry a
machine-readable `code` (`caste_key_immutable`, `caste_builtin_immutable`,
`caste_has_agents`, `caste_reassign_target_missing`, …). Every mutation
writes one company activity-log entry (`caste_created`, `caste_updated`,
`caste_removed`, `caste_removed_reassigned`).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| — | 1.6.1-CUSTOM-CASTES-A | — | The directory has no variables or settings document of its own: everything lives in the `agent_castes` table and changes through the API or the "Agent castes" settings screen | Nothing to disable; the table is additive |

## settings-ru-new

<!-- after: 1.6 — PARALLEL-HELPERS (делегируемые помощники агента) -->
### 1.6.1 — CUSTOM-CASTES A: справочник каст (ролей агентов) компании

Справочник за фичей: таблица `agent_castes` на компанию (миграция
`0304_agent_castes.sql` — только добавление, одна новая таблица с индексами,
существующие данные не перезаписываются), которая заменяет жёсткий список из
двенадцати ролей агентов на касты, заданные владельцем компании. В UI доски
это экран «Agent castes» в настройках компании; пользовательский walkthrough —
[guides/custom-castes.ru.md](guides/custom-castes.ru.md).

Справочник не добавляет переменных окружения: строки живут в таблице и
читаются из базы на каждый запрос (без кэша процесса), поэтому создание,
правка и удаление видны рою и каждому клиенту без перезапуска. Первое чтение
компании идемпотентно сеет двенадцать встроенных каст (вставляются только
отсутствующие ключи), помечая их `builtIn: true`; агенты, уже стоящие на
доске, сохраняют свои роли без изменений.

Каста несёт: `key` (стабильный идентификатор, латиница, цифры, дефисы и
подчёркивания, 1–60 символов, приводится к нижнему регистру — точная строка,
хранящаяся в `agents.role`; неизменяем), `nameEn` (обязательно) и `nameRu`,
`description`, `color` из палитры статусов (`primary`, `muted`, `blue`,
`amber`, `green`, `violet`, `red`, `gray`; умолчание `gray`), `icon`,
`defaultModel`, `swarmEligible` (умолчание `true`), `maxActiveTasks` (1–1000
или `null` для глобального потолка роя), и неизменяемый флаг `builtIn`.

REST API (`server/src/myrmidon/castes/`): `GET/POST
/api/myrmidon/companies/:companyId/castes` и `PATCH/DELETE
.../castes/:key`. Чтение требует доступа к компании; мутации — только board,
другая компания получает 403 на каждый маршрут. POST отвечает `201` (дубликат
ключа — `409`); PATCH отвечает `200` и отвергает `key`/`builtIn` в теле с
`400`; DELETE отвечает `204`. Каста с агентами на ней требует
`{"reassignTo": "<key>"}` в теле DELETE — без него ответ `409`
(`caste_has_agents`); с ним агенты переводятся на целевую касту и строка
удаляется одной транзакцией, их задачи в очереди следуют за ними, потому что
очереди роя строятся из `agents.role`. Тела ошибок несут машиночитаемый `code`
(`caste_key_immutable`, `caste_builtin_immutable`, `caste_has_agents`,
`caste_reassign_target_missing`, …). Каждая мутация пишет одну запись в журнал
активности компании (`caste_created`, `caste_updated`, `caste_removed`,
`caste_removed_reassigned`).

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| — | 1.6.1-CUSTOM-CASTES-A | — | У справочника нет переменных или своего документа настроек: всё живёт в таблице `agent_castes` и меняется через API или экран «Agent castes» | Нечего выключать; таблица только добавляется |
