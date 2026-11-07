## changelog-en

### Per-agent notification preferences mute event-shaped wakes (NOTIF-PREFS)

- An agent's `runtimeConfig.notifications` block now mutes whole wake event
  classes at generation time: `assignment` (issue assigned / assignment
  recovery), `mention` (a comment @-mentioned the agent) and `review`
  (execution review / approval requested, changes requested), plus an
  `enabled` master switch. Absence of the block — or any malformed field —
  means "notify": agents without a block behave exactly as before.
- The filter runs in `enqueueWakeup`, the single funnel every wake path goes
  through, so every call point (issue create, delegation, interactions,
  monitors, review handoff) is covered at once. Manual board wakes are an
  operator override and bypass the filter; reasons outside the three classes
  (timers, monitors, idle pickup, retries, …) always pass.
- A suppressed wake is logged (`wake suppressed by agent notification
  preferences`) and never becomes a run. Contract lives in
  `packages/shared/src/notification-prefs.ts`; decisions are covered by
  `packages/shared/src/notification-prefs.test.ts` and
  `server/src/__tests__/notification-prefs-wake.test.ts`.

## changelog-ru

### Персональные настройки уведомлений агента глушат побудки по событиям (NOTIF-PREFS)

- Блок `runtimeConfig.notifications` агента теперь глушит целые классы
  событий побудки в момент её генерации: `assignment` (задача назначена /
  восстановление назначения), `mention` (комментарий с @упоминанием агента) и
  `review` (запрос ревью/утверждения исполнения, запрошенные правки), плюс
  общий переключатель `enabled`. Отсутствие блока или любое некорректное
  поле означают «уведомлять»: агенты без блока ведут себя ровно как раньше.
- Фильтр выполняется в `enqueueWakeup` — единой воронке всех путей побудки, —
  поэтому покрыты все точки вызова одновременно: создание задачи, делегирование,
  взаимодействия, мониторы, передача на ревью. Ручные побудки с доски —
  приоритет оператора и фильтр обходят; причины вне трёх классов (таймеры,
  мониторы, idle pickup, ретраи и т.д.) проходят всегда.
- Подавленная побудка пишется в лог (`wake suppressed by agent notification
  preferences`) и никогда не становится прогоном. Контракт —
  `packages/shared/src/notification-prefs.ts`; решения покрыты тестами
  `packages/shared/src/notification-prefs.test.ts` и
  `server/src/__tests__/notification-prefs-wake.test.ts`.
