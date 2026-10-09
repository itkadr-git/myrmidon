---
settings-section: 1.6.1 — SWARM-SETTINGS-UI: очереди ролей как настройки инстанса
---

## changelog-en

### Task pheromone strength and task caste (1.6.5 F-27 PHEROMONE, rework per architect project 09.10)

- A task carries a numeric pheromone strength (`issues.pheromone_strength`, int ≥ 0):
  the swarm queue orders P0 first, then effective pheromone descending, then age.
  New tasks get their strength from the priority mapping in swarm settings
  (default critical 100 / high 30 / medium 10 / low 1).
- The task's caste is a first-class field `issues.caste_key` (a key of the company
  caste directory), with `projects.default_caste_key` as the project-level default;
  migration 0384 backfills strength from priority and moves `role:<key>` labels of
  known castes into `caste_key`. Queue routing resolves caste_key → project default
  → legacy `role:` label (compatibility).
- Effective pheromone (design §2.3): the stored strength plus aging
  (+1 per 24 h waiting, cap +5) minus a penalty (−10 per failed run since the last
  task change), floored at 0. A "task change" is a comment, or an audit row by a
  person or an agent, written after the failed run (the system actor and the run's
  own release stamp do not count). The SQL twin in
  `server/src/myrmidon/swarm-claim/effective-pheromone.ts` orders every queue read
  (before the candidate LIMIT), so a strong fresh task is never cut off.
  Parameters live in `instance_settings.general.swarmClaim.pheromone`.
- API: `casteKey`/`pheromoneStrength` on issue create/update; an unknown caste key
  is rejected with 422 `issue_caste_unknown`; null strength resets to the priority
  default. Projects accept `defaultCasteKey` with the same directory validation.
- UI: the issue card has "Caste" (directory select), "Pheromone strength" (number
  with an effective-strength hint) and a "P0" checkbox bound to `priority=critical`;
  the project card has "Default caste". The run-priority scoring gains a
  `pheromoneWeight × eff` term (default weight 1), bounded to 100 points so a huge
  strength cannot lift a run over the role and release bands.

## changelog-ru

### Сила феромона задачи и каста задачи (1.6.5 F-27 PHEROMONE, доработка по проекту архитектора 09.10)

- У задачи есть числовая сила феромона (`issues.pheromone_strength`, целое ≥ 0):
  очередь роя упорядочена — P0 первым, затем эффективная сила по убыванию, затем возраст.
  Новая задача получает силу из маппинга приоритета в настройках роя
  (по умолчанию critical 100 / high 30 / medium 10 / low 1).
- Каста задачи — поле `issues.caste_key` (ключ справочника каст компании) с
  умолчанием на уровне проекта `projects.default_caste_key`; миграция 0384 бэкфиллит
  силу из приоритета и переносит метки `role:<key>` известных каст в `caste_key`.
  Роутинг очереди: caste_key → каста проекта → метка `role:` (совместимость).
- Эффективная сила (design §2.3): хранимая сила плюс накопление по возрасту
  (+1 за 24 ч ожидания, кап +5) минус штраф (−10 за неудачный прогон после последнего
  изменения задачи), пол 0. «Изменение задачи» — комментарий либо запись аудита от
  человека или агента после упавшего прогона (системный актор и собственная отметка
  релиза прогона не считаются). SQL-двойник —
  `server/src/myrmidon/swarm-claim/effective-pheromone.ts` — упорядочивает все чтения
  очереди до LIMIT, сильная свежая задача не отсекается. Параметры — в
  `instance_settings.general.swarmClaim.pheromone`.
- API: `casteKey`/`pheromoneStrength` в create/update задачи; неизвестная каста —
  422 `issue_caste_unknown`; null силы сбрасывает к дефолту приоритета. У проекта —
  `defaultCasteKey` с той же валидацией по справочнику.
- UI: карточка задачи — «Каста» (выбор из справочника), «Сила феромона» (число с
  подсказкой эффективной силы), флажок «P0» ↔ `priority=critical`; карточка проекта —
  «Default caste». В скоринге очереди прогонов — слагаемое `pheromoneWeight × eff`
  (вес по умолчанию 1), ограничено 100 очками: огромная сила не поднимает прогон над
  полосами роли и релиза.

## settings-en-new

<!-- after: 1.6.1 — SWARM-SETTINGS-UI: queues of roles as instance settings -->
### 1.6.5 F-27 — task pheromone strength and task caste

| Variable / setting | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `general.swarmClaim.pheromone` (fields `critical`/`high`/`medium`/`low`) | 1.6.5-F27 | `{critical:100, high:30, medium:10, low:1}` | The pheromone strength a new task gets when the creator did not set one, by its priority. The single pheromone settings key (the Advanced block of the swarm page); no environment variable; read on every task create, no restart needed | A field not set — the built-in default. Integer 0–100000 |
| `general.swarmClaim.pheromone` (fields `agingStepHours`/`agingStep`/`agingCap`/`failPenalty`) | 1.6.5-F27-REWORK | `24` / `1` / `5` / `10` | Effective pheromone (design §2.3): `eff = strength + min(agingCap, floor(hoursWaiting/agingStepHours) × agingStep) − failPenalty × failedRunsSinceLastChange`, floored at 0. The swarm queue, idle sweep and supervisor rank by `eff`: P0 first, then `eff`, then age, then id. Updating the task clears the penalty. Read on every queue read, no restart needed | A field not set — the default. `agingStep=0` turns aging off; `failPenalty=0` turns the penalty off |
| `general.runPriority.pheromoneWeight` | 1.6.5-F27-REWORK | `1` | Weight of one effective-pheromone point in run-queue scoring (design §4): `pheromoneWeight × eff`. The swarm queue picks the task; this term moves its run inside the run queue's role band | 0–1000. `0` — the term is off. Unset — 1 |

## settings-ru-new

<!-- after: 1.6.1 — SWARM-SETTINGS-UI: очереди ролей как настройки инстанса -->
### 1.6.5 F-27 — сила феромона задачи и каста задачи

| Переменная / настройка | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `general.swarmClaim.pheromone` (поля `critical`/`high`/`medium`/`low`) | 1.6.5-F27 | `{critical:100, high:30, medium:10, low:1}` | Какую силу феромона (`issues.pheromone_strength`) получает новая задача без явно заданной силы, по её приоритету. Единственный ключ настроек феромона (блок «Advanced» страницы роя); переменной окружения нет, значение читается при каждом создании задачи — рестарт не нужен | Поле не задано — умолчание проекта. Целое 0–100000 |
| `general.swarmClaim.pheromone` (поля `agingStepHours`/`agingStep`/`agingCap`/`failPenalty`) | 1.6.5-F27-REWORK | `24` / `1` / `5` / `10` | Эффективная сила феромона (design §2.3): `eff = strength + min(agingCap, floor(часыОжидания/agingStepHours) × agingStep) − failPenalty × неудачныеПрогоныПослеПоследнегоИзменения`, пол 0. По `eff` ранжируют очередь роя, холостой проход и обзор супервизора: порядок — P0, затем `eff`, затем возраст, затем id. Изменение задачи сбрасывает штраф. Читается при каждом чтении очереди — рестарт не нужен | Поле не задано — умолчание. `agingStep=0` выключает старение; `failPenalty=0` — штраф |
| `general.runPriority.pheromoneWeight` | 1.6.5-F27-REWORK | `1` | Вес одного очка эффективной силы феромона задачи в скоринге очереди прогонов (design §4): `pheromoneWeight × eff`. Очередь роя выбирает задачу; этот член двигает её прогон внутри ролевой полосы очереди прогонов | 0–1000. `0` — член выключен. Не задана — 1 |

**Каста задачи (1.6.5 F-27 rework 09.10, design §2.1):** `issues.caste_key text NULL` —
каста задачи (ключ из справочника компании `agent_castes`); NULL — каста проекта
(`projects.default_caste_key`), затем умолчание компании. Миграция 0384 переносит
метки `role:<key>` в `caste_key` для каст, существующих в справочнике. API:
`casteKey`/`pheromoneStrength` в create/update задачи; неизвестная каста — 422
`issue_caste_unknown`. Карточка задачи: «Каста» (select из справочника), «Сила
феромона» (число + подсказка эффективной силы), флажок «P0» ↔ `priority=critical`.
Карточка проекта: «Default caste».
