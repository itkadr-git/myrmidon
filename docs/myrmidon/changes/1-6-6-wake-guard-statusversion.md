---
divergence-section: 1.6.6 — UPSTREAM-HANDOFF (часть B): версия задачи в охране побудок
---

## changelog-en

### A wake guard now also checks the issue version: a stale delivery no longer starts a turn (1.6.6 UPSTREAM-HANDOFF, part B)

- `issueStateGuard` gained the vendor's optional `statusVersion` (vendor PR
  #13686, commit `d82fbb0f`): a wake enlisted for an issue is admitted only
  while the issue still carries the version the wake was built for, so a
  delivery that waited behind a running turn and arrives after one or more
  later handoffs is dropped instead of starting an extra turn.
- The board's own queued-comment delivery now records the version it saw, and a
  dropped wake names `expectedStatusVersion` / `actualStatusVersion` beside the
  status and the assignee it already reported.
- A guard without the version keeps the previous behaviour, so every existing
  guard site stays unaffected.

## changelog-ru

### Охрана побудок проверяет ещё и версию задачи: устаревшая доставка больше не стартует ход (1.6.6 UPSTREAM-HANDOFF, часть B)

- В `issueStateGuard` добавлено вендорское необязательное поле `statusVersion`
  (вендорский PR #13686, коммит `d82fbb0f`): побудка, поставленная для задачи,
  допускается только пока задача несёт ту версию, для которой побудка
  поставлена, поэтому доставка, дождавшаяся работающего хода и пришедшая после
  одной и более поздних передач задачи, отбрасывается вместо запуска лишнего
  хода.
- Доставка очереди комментариев доски теперь записывает увиденную версию, а
  отброшенная побудка называет `expectedStatusVersion` / `actualStatusVersion`
  рядом со статусом и владельцем, о которых сообщала и раньше.
- Охрана без версии сохраняет прежнее поведение, поэтому все существующие
  точки постановки охраны не затронуты.

## divergence-new

### 1.6.6 — UPSTREAM-HANDOFF (часть B): версия задачи в охране побудок

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-UPSTREAM-HANDOFF-B | Портирование вендорского PR #13686 (коммит `d82fbb0f`) в части охраны побудок: необязательное `statusVersion` в типе `issueStateGuard`, его проверка в точке допуска побудки (`enqueueWakeup`) и версия в журнале отказа. Отличие от вендора: (1) вендор ставит версию только в своих точках постановки, мы дополнительно записываем её в доставке очереди комментариев доски (`heartbeat.ts`), чтобы устаревшая доставка не допускалась к задаче после поздней передачи; (2) в журнал отказа добавлены `expectedStatusVersion`/`actualStatusVersion` — у вендора там только ожидаемый/фактический статус и владелец | Наш файл: `server/src/services/heartbeat.ts` (тип `issueStateGuard`; `enqueueWakeup`: select версии, проверка, журнал отказа; доставка очереди комментариев — запись версии), помечено `myrmidon(1.6.6-UPSTREAM-HANDOFF-B)`. Тест: `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts` | Эпик 1.6.6 UPSTREAM-HANDOFF, часть B (OPE-5067): без версии устаревшая побудка, допущенная после одной и более поздних передач задачи, стартует лишний ход — класс «задвоенных передач» на стороне доставки | `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts` — «checks the guarded issue status version under the enqueue lock»: совпадение версии → допуск, поле отсутствует → прежнее поведение, версия отстала/опередила → отказ с `expectedStatusVersion`/`actualStatusVersion` | Когда вендор сам начнёт ставить версию в доставке очереди комментариев и назовёт версию в журнале: убрать строки с меткой `myrmidon(1.6.6-UPSTREAM-HANDOFF-B)`, оставить вендорскую проверку | (этот PR) |