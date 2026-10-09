---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### A task with a scheduled monitor is not picked up by idle pickup (IDLE-PICKUP-MONITOR)

- An issue whose `monitor_next_check_at` lies in the future no longer counts
  as a ready idle-pickup candidate: its wake already has an owner —
  `tickDueIssueMonitors` fires it exactly at the scheduled time (for the
  `in_progress`/`in_review` statuses). Until now the candidate prefilter never
  read the column, and such an issue burned a no-op run on every sweep pass
  until the monitor fired.
- The filter is one shared SQL prefilter, so both consumers follow at once:
  the periodic sweep and the WAKE-BIND binding (`findTopReadyIssueForAgent`),
  which picks the task a manual wake without an explicit issue binds to.
- An elapsed monitor (`monitor_next_check_at <= now`) is NOT excluded: the
  monitor tick owns that wake, and suppressing readiness there serves nothing.
- The behaviour is strict — no switch is added and none is needed.

## changelog-ru

### Задача с запланированным монитором не подбирается IDLE-PICKUP (IDLE-PICKUP-MONITOR)

- Задача, у которой `monitor_next_check_at` в будущем, больше не считается
  готовым кандидатом IDLE-PICKUP: владелец её побудки уже назначен —
  `tickDueIssueMonitors` будит её ровно в назначенное время (для статусов
  `in_progress`/`in_review`). Раньше префильтр кандидатов эту колонку не
  читал, и такая задача сжигала холостой прогон на каждом проходе подметания
  до срабатывания монитора.
- Фильтр один на общий SQL-префильтр, поэтому ему следуют оба потребителя
  сразу: периодический проход и привязка WAKE-BIND
  (`findTopReadyIssueForAgent`), выбирающая задачу для ручной побудки без
  явного указания задачи.
- Наступивший монитор (`monitor_next_check_at <= now`) НЕ исключается: этой
  побудкой владеет тик монитора, а подавлять готовность здесь незачем.
- Поведение строгое — ручка отключения не добавляется и не требуется.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| IDLE-PICKUP-MONITOR | Префильтр кандидатов IDLE-PICKUP (`idlePickupCandidateRows`) исключает задачи с `monitor_next_check_at` строго в будущем (`is not null and > now()`): их побудкой владеет `tickDueIssueMonitors`, а холостые проходы сжигали прогон каждый интервал подметания. Один префильтр покрывает оба пути — периодический проход и WAKE-BIND (`findTopReadyIssueForAgent`); наступивший монитор не исключается. У вендора IDLE-PICKUP нет вообще, наш блок расширяет понятие «готовой задачи» | `server/src/myrmidon/idle-pickup.ts` (метка `myrmidon(IDLE-PICKUP-MONITOR)`) | 09.10 in_progress-задача с будущим монитором дала 4 холостых прогона за 2 часа (00:29–02:13Z): префильтр колонку не читал, монитор ещё не наступил | `server/src/__tests__/idle-pickup.myrmidon.test.ts` (будущий монитор — не будится ни sweep'ом, ни WAKE-BIND; истёкший и отсутствующий монитор — выбираются) | Никогда, наше поведение. Снятие: удалить условие с меткой `myrmidon(IDLE-PICKUP-MONITOR)` из `idlePickupCandidateRows` и его тесты | (этот PR) |
