## divergence-new

<!-- after: 1.6.5 — DB-PERF C: last_activity_at в issues вместо коррелированных MAX -->

### 1.6.5 — F-26 T10 SWARM-SCENT: запах задачи и агента, логика Jev

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.5-SWARM-SCENT | Запах задачи и агента (§7.1 п.4a): один структурированный вызов через LiteLLM (`response_format: json_schema`, `additionalProperties: false`) размечает задачу — `issues.scent` = {вероятности каст по справочнику компании, ≤8 тегов, тройка сложности Jev coordination/uncertainty/consequences} — и агента: `agents.scent_tags` + `agents.model_tier` из `capabilities`. Хук создания задачи (чистая функция `deriveScentAuto`, сервер): явная каста не перезаписывается никогда (источник становится 'manual'); при пустой касте и p топ-касты ≥ 0.5 пишется `caste_key` + `caste_source='auto'`; иначе `caste_key` остаётся NULL — цепочка §2.1 (`task ?? project default ?? company default`) применяется при чтении, компания по умолчанию НЕ материализуется как 'auto'. Сила: явная не трогается; иначе `scentTaskStrength(priority, scent)` = база по приоритету + consequencesBonus при consequences ≥ 0.65. Создание задачи никогда не ждёт классификатор: запах приходит асинхронно и в той же записи (`UPDATE`) ставит авто-касту (только если `caste_key` пуст или это прежний выбор `auto`; явная каста не трогается) и бонус силы за последствия (только если сила ещё равна базе приоритета) — очередь разметки на СОБСТВЕННОМ таймере (не heartbeat; пачка ≤ `classifierBatchSize`, лимит «1 вызов/запись/час» считает И успехи, И отказы по журналу, поэтому отказ шлюза не долбит те же записи каждый тик; в очереди только ОТКРЫТЫЕ todo задачи — done/cancelled история не тратит токены — и агенты с пустыми тегами и непустым capabilities). Задача без описания в классификатор не уходит (§2.4) — пустой запах, каста по §2.1. Счёт `scentScore(task, agent, weights)` и `pickAgentForTask` (максимум счёта, ничья → меньший id) — чистый контракт shared для T1. Учёт: `issue.scent_classified`/`agent.scent_classified` в журнале активности с моделью и токенами на КАЖДУЮ попытку (бюджет «< 1 М входных токенов/сутки» читается из этих записей). REST: `POST /api/myrmidon/companies/:cid/issues/:id/scent/refresh`, `POST /api/myrmidon/companies/:cid/agents/:id/scent/refresh` (часовой лимит действует и тут), `GET /api/myrmidon/companies/:cid/swarm/scent/status`. Настройки `general.swarm.scent` (enabled, model — псевдоним шлюза, веса tagWeight/tierFit/seriousThreshold/consequencesBonus, таймаут, лимиты очереди); адрес шлюза `MYRMIDON_SCENT_BASE_URL` (фолбэк `MYRMIDON_EVALS_BASE_URL`), ключ — из env по имени `MYRMIDON_SCENT_KEY_SECRET` (по умолчанию `MYRMIDON_EVALS_API_KEY` — тот же контур, что у судьи evals; чтение ключа — только на сервере, shared-пакет `process.env` не трогает). Миграция 0385 (после 0382/0383 T2 и 0384 T3): `issues.scent` jsonb, `agents.scent_tags` text[] NOT NULL DEFAULT '{}', `agents.model_tier` NOT NULL DEFAULT 'light', `agents.scent_classified_at`, `agent_castes.model_tier` NOT NULL DEFAULT 'light'. UI: `IssueScentFields.tsx` (теги, сложность, пометка «авто», кнопка «переразметить») и `AgentScentFields.tsx` (теги, уровень модели) — монтируют T2/T3 в свои формы; веса — в панели T4. | Наши файлы: `packages/shared/src/myrmidon-scent.ts` (+тест), `server/src/myrmidon/scent/{gateway,service,create-hook,queue,routes,index}.ts`, `server/src/myrmidon/scent.myrmidon.test.ts`, `packages/db/src/migrations/0385_swarm_scent.sql` (+`meta/0385_snapshot.json`, `_journal.json`), `ui/src/components/myrmidon/{IssueScentFields,AgentScentFields}.tsx`; в вендоре помечено `myrmidon(1.6.5 F-26 T10`: `packages/db/src/schema/{issues,agents,agent_castes}.ts` (только колонки §7.1 п.4a — `pheromone_strength`/`caste_key`/`is_default` принадлежат T2/T3), `packages/shared/src/validators/{issue,instance}.ts`, `packages/shared/src/index.ts`, `server/src/services/issues.ts` (хук создания), `server/src/app.ts` (маршруты), `server/src/index.ts` (таймер очереди) | F-26 T10: задачу берёт свободный агент касты, чей запах совпадает; каста и сила ставятся автоматически одним вызовом, без побудок и прогонов; классификатор никогда не ломает создание задачи | `packages/shared/src/myrmidon-scent.test.ts` (счёт, выбор агента, ничья, сила, веса, настройки); `server/src/myrmidon/scent.myrmidon.test.ts` (хук создания через `deriveScentAuto`: «поправить CSS кнопки» → engineer p>0.5 на моке шлюза; задача без описания → пустой запах, каста по §2.1, классификатор не вызывается; агент с 2 тегами побеждает агента с 1; consequences 0.7 → strong, не light; явная каста не перезаписывается; отказ шлюза не ломает создание; лимит часа считает отказы; очередь — только открытые todo) | Никогда, наше поведение. Снятие = флаг `general.swarm.scent.enabled=false` (классификатор гаснет, очередь проходит вхолостую, создание задач не затронуто) | design.md §2.4, §7.1 п.4a, §8, §9; задача OPE-6642 |

## settings-en-new

<!-- after: 1.6.5 — DOCKERGATE-A2A3-STORM: board pacing toward dockergate -->

### 1.6.5 — SWARM-SCENT: task/agent scent classification

New `general.swarm.scent` settings section (Instance → General, swarm family): master
switch `enabled` (default on), gateway model alias `model`, scoring weights `tagWeight` /
`tierFit` / `seriousThreshold` / `consequencesBonus`, classifier timeout (20 s), and the
markup-queue limits (batch size, one classification per record per hour — attempts count,
successes and failures alike). The classifier endpoint comes from `MYRMIDON_SCENT_BASE_URL`
(falling back to `MYRMIDON_EVALS_BASE_URL`) and its key from the env variable named by
`MYRMIDON_SCENT_KEY_SECRET` (default `MYRMIDON_EVALS_API_KEY`) — the same contour the evals
judge uses. The shared package never reads `process.env`: env overrides are passed in by
the server.

## settings-ru-new

<!-- after: 1.6.5 — DOCKERGATE-A2A3-STORM: согласование темпа запросов доски к dockergate -->

### 1.6.5 — SWARM-SCENT: запах задачи и агента

Новая секция `general.swarm.scent` (Instance → General, семейство swarm): главный
выключатель `enabled` (по умолчанию включён), псевдоним модели шлюза `model`, веса счёта
`tagWeight` / `tierFit` / `seriousThreshold` / `consequencesBonus`, таймаут классификатора
(20 с) и лимиты очереди разметки (размер пачки, одна классификация на запись в час —
учитываются и успехи, и отказы). Адрес классификатора — `MYRMIDON_SCENT_BASE_URL` (фолбэк
`MYRMIDON_EVALS_BASE_URL`), ключ — из переменной окружения, чьё имя задаёт
`MYRMIDON_SCENT_KEY_SECRET` (по умолчанию `MYRMIDON_EVALS_API_KEY`) — тот же контур, что у
судьи эталонов. Shared-пакет `process.env` не читает: переопределения из env передаёт
сервер.
