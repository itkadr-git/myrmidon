<!-- myr/1.6.6-blocked-loop-reasonref — BLOCKER-WAKE-LOOP B: event deadline + waiting docs -->

## changelog-en

### Stale-block watchdog: an event reason can carry a deadline (BLOCKER-WAKE-LOOP B)

- `unblockDescriptor.reasonRef {kind:"event"}` accepts an optional `dueAt`
  deadline. Once it passes, the reason is judged dead even while the
  `isEventStillSet` seam still reports the gate set — an unwired gate key can
  no longer hold a task blocked forever (the seam default is still-set).
- A deadline lift is reported as "the event deadline passed" in the system
  comment and the activity row. Event reasons without a deadline and all
  `kind:"date"` reasons are judged exactly as before (backward compatible).
- New executor-facing section "Waiting on an external condition" in
  `docs/myrmidon/guides/stale-block.md` (+ Russian mirror): express a date,
  tag or event wait as `reasonRef {kind:"date"|"event", dueAt}` or an issue
  monitor `executionPolicy.monitor.nextCheckAt` — never a homemade
  blocked↔todo wake loop; the watchdog is the ceiling, the monitor is the
  alarm clock.

## changelog-ru

### Сторож stale-block: у причины-события появился дедлайн (BLOCKER-WAKE-LOOP B)

- `unblockDescriptor.reasonRef {kind:"event"}` принимает необязательный
  дедлайн `dueAt`. После его прохождения причина судится мёртвой, даже пока
  шов `isEventStillSet` отвечает, что гейт установлен, — неподключённый ключ
  гейта больше не может держать задачу в `blocked` вечно (умолчание шва —
  «установлен»).
- Снятие блока по дедлайну описывается текстом «the event deadline passed» в
  системном комментарии и activity-записи. Причины-события без дедлайна и
  все причины `kind:"date"` судятся как раньше (обратная совместимость).
- Новый раздел «Ожидание внешнего условия (для исполнителей)» в
  `docs/myrmidon/guides/stale-block.md` (+ русское зеркало): ожидание даты,
  тега или события выражается через `reasonRef {kind:"date"|"event", dueAt}`
  или монитор задачи `executionPolicy.monitor.nextCheckAt` — никогда
  самодельным циклом побудок blocked↔todo; сторож — это потолок, монитор —
  будильник.
