---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### A review that waits on a person is a lawful wait state (HUMAN-REVIEW-WAIT)

- An issue delivered to review (`in_review`) that stays assigned to its agent
  executor can now declare `reviewPolicy: "human_only"` as its review path.
  The board then treats the review as covered by a human reviewer: the executor
  is not woken, no "review path lost" recovery fires, no disposition is
  demanded, and automatic review routing never hands the verdict to an agent
  reviewer. A human comment or attachment still wakes the assignee as usual.
- Before the fix, a review the owner (a person) must approve looked stalled to
  the board's liveness mechanism: after every finished run the executor got an
  `issue_review_path_lost` wake every few minutes and each turn ended with
  another "waiting for the owner" comment. A deliberate `blocked` wait with an
  `unblockDescriptor` was also rolled back to `in_progress` minutes later by
  the stale-block watchdog when the reason was an event gate without a readable
  key, and the liveness sweep then demanded a disposition. Key-less event
  reasons are now unknown facts: the watchdog leaves the block alone.
- Agents moving an issue to `in_review` may set `reviewPolicy: "human_only"`
  in the same update as the review path; the invalid-disposition guard accepts
  it next to an interaction, approval, human assignee, review participant or
  monitor.
- The decisions feed shows only reviews that genuinely lack a maintained path
  (PAP-16080): a covered human wait is by definition not a stalled-review
  card, so no "choose review path" demand appears while the person reads.

## changelog-ru

### Ожидание человека на приёмке — законное состояние ожидания (HUMAN-REVIEW-WAIT)

- Сданная на приёмку задача (`in_review`), оставленная на исполнителе-агенте,
  теперь может объявить `reviewPolicy: "human_only"` как путь ревью. Доска
  считает такое ревью покрытым человеком-проверяющим: исполнитель не получает
  побудок, восстановление «путь ревью потерян» не срабатывает, решение не
  требуют, а автоматическая маршрутизация приёмки не отдаёт вердикт
  агенту-ревьюеру. Комментарий или вложение от человека будит исполнителя
  по-прежнему.
- До исправления приёмка, которую должен решить владелец (человек), выглядела
  для механизма живости зависшей: после каждого завершённого прогона
  исполнитель получал побудку `issue_review_path_lost` каждые несколько минут,
  и каждый ход заканчивался новым комментарием «жду владельца». Осознанная
  пауза в `blocked` тоже откатывалась подметальщиком зависших блоков обратно в
  `in_progress` через несколько минут, если причиной был указан событийный
  гейт без читаемого ключа; после отката механизм живости требовал решения.
  Событийная причина без ключа теперь — неизвестный факт: подметальщик не
  трогает блок.
- Агент, переводящий задачу в `in_review`, может задать
  `reviewPolicy: "human_only"` тем же обновлением как путь ревью; сторож
  невалидной диспозиции принимает его наравне с ожидающей карточкой,
  human-назначением, участником приёмки и монитором.
- Лента решений (`/decisions`) показывает только приёмки без поддерживаемого
  пути (PAP-16080): покрытое ожидание человека по определению не зависшая
  приёмка, поэтому требование «выбери путь ревью» не появляется, пока человек
  читает.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| HUMAN-REVIEW-WAIT | Приёмка `in_review` с `reviewPolicy: "human_only"` на исполнителе-агенте — законное состояние «ждёт человека»: классификатор путей ревью добавляет факт `human_reviewer` (резолвер — `responsibleUserId`, иначе автор-человек), поэтому механизм живости не считает такую приёмку зависшей: `issue_review_path_lost` и `in_review_without_action_path` не будят исполнителя и не требуют решения до ответа человека; сторож невалидной диспозиции при PATCH в `in_review` принимает `reviewPolicy: "human_only"` как реальный путь ревью; подметальщик живости приёмки (review-routing) не отдаёт human-only ревью агенту-ревьюеру; repair-механизм диспозиций считает human-only ожидающий путь долговременным; тот же предикат у сторожевой задачи; событийная причина зависшего блока без ключа — неизвестный факт: блок не снимается (откат `blocked` → `in_progress` будившимся прогоном больше не случается) | `server/src/services/recovery/issue-graph-liveness.ts`, `server/src/services/issues.ts`, `server/src/routes/issues.ts`, `server/src/services/recovery/disposition-repair.ts`, `server/src/services/recovery/successful-run-handoff.ts`, `server/src/services/task-watchdogs.ts`, `server/src/modules/run-dispatch/adapters/postgres.ts`, `server/src/myrmidon/stale-block/policy.ts`, `server/src/myrmidon/review-routing/{policy,store}.ts` | 05.10: сданная владельцу-человеку колода будила дизайнера сигналом `issue_review_path_lost` каждые ~5 минут, каждый ход заканчивался комментарием «жду владельца»; попытка `blocked` с `reasonRef kind=event` откатывалась подметальщиком и требовала решения. Вендор не различает «ждёт человека» и «путь ревью потерян» | `server/src/services/recovery/issue-graph-liveness.human-review-wait.myrmidon.test.ts`, `server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts` (час wake-циклов на human-only ревью → 0 побудок), `server/src/__tests__/issue-review-attention.test.ts`, `server/src/__tests__/issue-execution-policy-routes.test.ts`, `server/src/__tests__/attention-service.test.ts`, `server/src/myrmidon/stale-block/policy.myrmidon.test.ts`, `server/src/myrmidon/review-routing/policy.myrmidon.test.ts` | Когда вендор признает ожидающую человека приёмку покрытой (human-only ревью в классификаторе путей) и перестанет снимать блок по нечитаемой причине: удалить куски `myrmidon(HUMAN-REVIEW-WAIT)`, тесты переписать на поведение вендора | (этот PR) |
