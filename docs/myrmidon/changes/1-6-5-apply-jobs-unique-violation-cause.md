## changelog-en

### Racing "Apply now" presses no longer leak a wrapped unique violation (1.6.5 CI-RACE)

- When two POSTs raced for one bot, the loser of the `bot_apply_jobs`
  live-job unique index hit the database rejection and re-read the winner's
  row — but only when the error reached it as a plain Postgres error. Drizzle
  wraps driver failures in its own `Failed query: ...` error and the SQLSTATE
  code lives on `cause`, so the local copies of `isUniqueViolation` in
  `server/src/myrmidon/bot-containers/apply-jobs.ts` and
  `scope-wiring.ts` — which read only the top-level error — missed it and
  re-threw. The flake surfaced as a red CI on `rel/1.6.5-rc.7`
  ("two racing acquires of one bot end with one job and one creator").
- Both copies are deleted; the modules now import the canonical
  `isUniqueViolation` from `server/src/db-errors.ts`, which unwraps the
  `cause` chain (same helper the swarm-claim store and recovery service
  already use, covered by `server/src/__tests__/db-errors.test.ts`).
- Call-site behaviour is unchanged everywhere: losers still hand back the
  winner's row (`created=false`), scope-group conflicts still answer
  `null` / `"name-taken"`.
- Guard: `server/src/myrmidon/bot-containers/apply-jobs.myrmidon.test.ts`
  gains a deterministic test — a proxy over the real database throws the
  drizzle-wrapped 23505 exactly once (after the winner's row lands for
  real) and the store must return the winner instead of raising. Red on
  the old code, green on the fix.

## changelog-ru

### Гонка двух нажатий «Применить» больше не выбрасывает наружу обёрнутый unique violation (1.6.5 CI-RACE)

- При гонке двух POST-ов за одного бота проигравший по частичному
  уникальному индексу живой заявки `bot_apply_jobs` перечитывал строку
  победителя, только если ошибка доходила как «чистая» ошибка Postgres.
  Drizzle оборачивает сбой драйвера в собственную ошибку `Failed
  query: ...`, а SQLSTATE лежит в `cause` — локальные копии
  `isUniqueViolation` в `server/src/myrmidon/bot-containers/apply-jobs.ts`
  и `scope-wiring.ts` (читали только верхний объект) её не видели и
  бросали дальше. Флак вылез красным CI на `rel/1.6.5-rc.7` в тесте
  «two racing acquires of one bot end with one job and one creator».
- Обе копии удалены; модули импортируют канонический `isUniqueViolation`
  из `server/src/db-errors.ts`, который разворачивает цепочку `cause`
  (тот же помощник уже используют swarm-claim и recovery service, покрыт
  `server/src/__tests__/db-errors.test.ts`).
- Поведение мест вызова не изменилось: проигравший по-прежнему возвращает
  строку победителя (`created=false`), конфликты групп областей — `null` /
  `"name-taken"`.
- Тест-сторож: в
  `server/src/myrmidon/bot-containers/apply-jobs.myrmidon.test.ts` добавлен
  детерминированный тест — прокси над реальной базой бросает обёрнутый
  drizzle 23505 ровно один раз (после того как строка победителя реально
  вставлена), и стор обязан вернуть победителя, а не упасть. На старом
  коде красный, на правке зелёный.
