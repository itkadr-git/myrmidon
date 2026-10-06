---
divergence-section: 1.6.1 — STALE-BLOCK, часть B: сторож-sweep мёртвых блоков
---

## divergence

| 1.6.1-CUSTOM-CASTES-A | Справочник каст компании (ролей агентов) в БД вместо жёсткой константы: аддитивная таблица `agent_castes` (companyId FK, key — стабильный идентификатор, совпадающий с `agents.role`, nameEn/nameRu, description, color из токен-слоя, icon, defaultModel, swarmEligible, maxActiveTasks int\|null, builtIn, unique (companyId, key)), ленивый идемпотентный seed 12 встроенных каст из `AGENT_ROLES`/`AGENT_ROLE_LABELS` при первом чтении компании, REST CRUD `GET/POST /api/myrmidon/companies/:id/castes`, `PATCH/DELETE .../castes/:key` (мутации — только board, чтение — company access). DELETE с телом `{"reassignTo": "<key>"}`: каста с агентами и без reassignTo — 409 «агенты стоят на касте»; с ним — агенты с `role = key` переводятся на целевую касту и каста удаляется одной транзакцией; очередь роя строится по `agents.role` (`roleQueueRows`), поэтому задачи переведённых агентов уходят в очередь новой касты автоматически. `key` и `builtIn` неизменяемы (PATCH с ними — 400). Живость: чтение из БД на каждом запросе, без кэша строк и без env | Наши файлы: `packages/shared/src/myrmidon-castes.ts` (контракт: CasteView, zod-схемы POST/PATCH/DELETE, seed-набор), `packages/db/src/schema/agent_castes.ts`, миграция `0301_agent_castes.sql` (+ meta journal/snapshot), `server/src/myrmidon/castes/{store,service,routes,wiring}.ts`; в вендоре помечены `myrmidon(CUSTOM-CASTES)`: `packages/shared/src/index.ts` (экспорт контракта), `packages/db/src/schema/index.ts` (экспорт таблицы), `server/src/app.ts` (одна строка монтирования роутера), `docs/myrmidon/SETTINGS.md` (своя секция) | 1.6.1 CUSTOM-CASTES: роли агентов перестают быть жёстким списком из 12 — их задаёт владелец компании; от касты зависит очередь роя SWARM-CLAIM. `agents.role` НЕ мигрируется и не валидируется на этапе seed — текущие роли агентов остаются как есть (валидатор меняет параллельная часть B) | `castes.db.myrmidon.test.ts` (seed 12 идемпотентно; POST/дубль 409; PATCH изменяемые поля, key/builtIn — 400; DELETE без агентов 204, с агентами без reassignTo 409, с reassignTo — агенты переведены и каста удалена транзакционно, задача в очереди новой касты; границы компаний), `castes-api.myrmidon.test.ts` (доступ: чужая компания 403, агент читает но не мутирует, board мутирует) | Никогда, наше поведение. Удаляется вместе с эпиком: удалить каталог, таблицу нельзя (миграции идут только вперёд), снять строки с меткой `myrmidon(CUSTOM-CASTES)` | (этот PR) |

## settings-en-new

<!-- after: 1.6 — PARALLEL-HELPERS (delegated helper agents) -->

### CUSTOM-CASTES — the company caste (agent role) directory

Settings of `server/src/myrmidon/castes/` — the company caste directory and its
REST API (`GET/POST /api/myrmidon/companies/:companyId/castes`,
`PATCH/DELETE .../castes/:key`). No variables: the directory lives in the
`agent_castes` table, is read from the database on every request (no process
cache, no env), and seeds the 12 built-in castes idempotently on a company's
first read — so create/assign/delete are visible to the swarm without a
restart. Mutations are board-only; reads need company access.
