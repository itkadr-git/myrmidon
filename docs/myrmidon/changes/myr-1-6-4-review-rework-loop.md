---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Review-return loop: a RETURN verdict opens the rework task itself (REVIEW-REWORK)

- A review verdict that returns a pull request used to hang: no rework task
  appeared, the review stayed in `todo`, and the reviewer was woken every
  10–30 minutes on an unchanged lane (OPE-4417 waited 7 hours on PR #484 like
  this; OPE-4360 kept a todo card on an already-merged PR). Now a sweeper
  (every 60 s, per company) reads the verdict — a `VERDICT …#<N>: RETURN`
  marker on the review task, or the PR's aggregate GitHub `CHANGES_REQUESTED`
  decision, the newest word wins — and:
  1. opens a rework task (a child of the review, linked to the verdict's
     comment and head sha) with the executor chosen down the ladder: the
     review's return assignee (the PR's author) → the assignee of the task the
     PR delivers → the instance fallback setting → nobody, which leaves the
     task in the role queue for SWARM-CLAIM; the executor is woken;
  2. moves the review task to `blocked` pointing at the rework, so the
     reviewer stops being woken while the work is out;
  3. when the PR head moves past the recorded baseline, lifts the block back
     to `todo`, records a `HEAD-ACK <pr>: <sha>` line (which retires the
     verdict signal) and wakes the reviewer with the new head;
  4. closes the review (`done`) when every linked PR is merged or closed, and
     reopens the same rework task — never a duplicate — when a newer RETURN
     lands on a settled one.
- Instance → General gains a "Review-return loop (REVIEW-REWORK)" section: the
  master switch and the fallback executor, `GET`/`PATCH
  /api/myrmidon/review-rework`, stored in `instance_settings.general.reviewRework`
  with a change journal; the sweep re-reads the row every pass, so a change
  applies without a restart. Off restores the old behaviour exactly.
- An unresolvable PR (no token, GitHub outage) moves nothing: the loop never
  invents a merge, a head move, or a verdict.

## changelog-ru

### Цикл возврата ревью: вердикт RETURN сам порождает задачу доработки (REVIEW-REWORK)

- Возврат ревью повисал: задача на доработку не появлялась, ревью стояло в
  `todo`, ревьюера будили каждые 10–30 минут на неизменную ветку (OPE-4417
  так ждал 7 часов по PR #484; OPE-4360 висел в `todo` на уже слитом PR).
  Теперь наблюдатель (каждые 60 с по компании) читает вердикт — маркер
  `VERDICT …#<N>: RETURN` в задаче ревью или агрегированное решение GitHub
  `CHANGES_REQUESTED` (последнее по времени слово важнее) — и:
  1. создаёт задачу доработку (ребёнок ревью со ссылкой на коммент вердикта и
     head) с исполнителем по лестнице: return-assignee ревью (автор PR) →
     исполнитель задачи, которую PR доставляет → запасной из настройки
     экземпляра → никто (задача падает в очередь ролей SWARM-CLAIM);
     исполнителя будит;
  2. переводит ревью в `blocked` со ссылкой на доработку — ревьюер перестаёт
     просыпаться, пока работа не сделана;
  3. когда head PR меняется относительно записанной базы, снимает блок в
     `todo`, пишет строку `HEAD-ACK <pr>: <sha>` (вердикт считается
     отработанным) и будит ревьюера с новым head;
  4. закрывает ревью (`done`), когда все связанные PR слиты или закрыты, и
     переоткрывает ту же задачу доработки (не дублируя) на более новый RETURN.
- В Instance → General добавлен раздел «Review-return loop (REVIEW-REWORK)»:
  выключатель и запасной исполнитель, `GET`/`PATCH /api/myrmidon/review-rework`,
  хранение в `instance_settings.general.reviewRework` с журналом изменений;
  наблюдатель перечитывает строку на каждом проходе — изменение применяется
  без рестарта. В выключенном состоянии поведение доски прежнее.
- Нераспознанный PR (нет токена, GitHub недоступен) ничего не двигает: цикл
  не выдумывает ни слияние, ни новый head, ни вердикт.

## divergence

| REVIEW-REWORK | Наблюдатель цикла возврата ревью: по маркеру `VERDICT #N: RETURN` (коммент задачи) или решению GitHub `CHANGES_REQUESTED` создаёт/переоткрывает задачу доработку, блокирует ревью на ней, снимает блок по смене head с побудкой ревьюера, закрывает ревью на слитом/закрытом PR. Запись — только через `issueService.update/create` под блокировкой строки (журнал, dependency-wake, disposition работают как при ручном ходе); состояние доработки — в существующих полях `originKind/originId/originFingerprint`, без новых колонок. Настройки — в `instance_settings.general.reviewRework` (ключ сохраняется `normalizeGeneralSettings`) | изменённые файлы вендора (точки вживления): `server/src/index.ts`, `server/src/app.ts`, `packages/shared/src/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts`, `server/src/services/instance-settings.ts`, `ui/src/pages/InstanceGeneralSettings.tsx`; новые: `+ server/src/myrmidon/review-rework/`, `+ packages/shared/src/myrmidon-review-rework.ts`, `+ packages/shared/src/myrmidon-review-rework.test.ts`, `+ ui/src/components/myrmidon/ReviewReworkSettingsPanel.tsx`, `+ ui/src/components/myrmidon/reviewReworkSettingsApi.ts`, `+ ui/src/components/myrmidon/ReviewReworkSettingsPanel.myrmidon.test.tsx` | Вердикт RETURN не порождал работу: ревью висело в `todo` и будило ревьюера впустую (OPE-4417 7 часов; OPE-4360, OPE-4442 так же); доработку создавал оператор доски руками | `server/src/myrmidon/review-rework/domain.myrmidon.test.ts`, `server/src/myrmidon/review-rework/sweep.myrmidon.test.ts` (три перехода приёмки и гейты прохода), `packages/shared/src/myrmidon-review-rework.test.ts`, `ui/src/components/myrmidon/ReviewReworkSettingsPanel.myrmidon.test.tsx` | Никогда — наше поведение. Снятие: `enabled=false` в настройках; полностью — удалить `server/src/myrmidon/review-rework/`, перечисленные новые файлы и точки вживления | (этот PR) |
