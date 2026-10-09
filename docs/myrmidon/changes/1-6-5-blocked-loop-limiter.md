---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### An agent can no longer bounce a task into blocked forever (BLOCKED-LOOP, 1.6.5)

- Every return to `blocked` is legal on its own and rewrites
  `blockedTransitionAt`, so a task whose agent re-blocked it again and again
  on a condition the board does not model woke the agent again and again.
- Now an agent that returns a task to `blocked` more than
  `MYRMIDON_BLOCKED_LOOP_MAX_RETURNS` times (default 3) in a row with the same
  blocker set and the same `unblockDescriptor` gets `422` with
  `code: "blocked_loop_limit"`; the message says to express the external wait
  with an issue monitor (`executionPolicy.monitor.nextCheckAt`) or
  `unblockDescriptor.reasonRef` kind `event`/`date`.
- The streak is reset by a change of the blocker set, a different
  `unblockDescriptor`, any action of a person, or a move of the task to
  `done`, `cancelled` or `in_review`. Board and other human actors are never
  limited. A rejection is recorded as the activity `myrmidon.blocked_loop.rejected`
  (streak, limit, task identifier) so the lead can see it.

## changelog-ru

### Агент больше не может бесконечно возвращать задачу в blocked (BLOCKED-LOOP, 1.6.5)

- Каждый возврат в `blocked` законен сам по себе и перезаписывает
  `blockedTransitionAt`, поэтому задача, которую агент раз за разом
  блокировал по условию, которого нет на доске, раз за разом будила агента.
- Теперь агент, возвращающий задачу в `blocked` больше
  `MYRMIDON_BLOCKED_LOOP_MAX_RETURNS` раз (по умолчанию 3) подряд с тем же
  набором блокеров и тем же `unblockDescriptor`, получает `422` с
  `code: "blocked_loop_limit"`; текст велит выразить внешнее ожидание
  монитором задачи (`executionPolicy.monitor.nextCheckAt`) или
  `unblockDescriptor.reasonRef` вида `event`/`date`.
- Серию обнуляют смена набора блокеров, другой `unblockDescriptor`, любое
  действие человека над задачей и уход задачи в `done`, `cancelled` или
  `in_review`. Board и другие люди не ограничиваются. Отказ пишется в
  activity как `myrmidon.blocked_loop.rejected` (серия, лимит, идентификатор
  задачи), чтобы его видел лид.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.5-BLOCKED-LOOP | Лимитер повторных возвратов в `blocked`: на входе в `blocked` от агента (`req.actor.type === "agent"`) из `activity_log` берутся последние события смены статуса задачи; подряд идущие входы агента с тем же набором блокеров и тем же `unblockDescriptor` считаются, и при достижении `MYRMIDON_BLOCKED_LOOP_MAX_RETURNS` (умолчание 3) мутация отклоняется `422 { code: "blocked_loop_limit" }` до записи; отказ пишет activity `myrmidon.blocked_loop.rejected`. Подпись входа (`blockedLoop: { blockerSetKey, descriptorKey }`) кладётся в `details` обычной записи `issue.updated`. Серию рвут действие человека, смена блокеров или дескриптора, уход в `done`/`cancelled`/`in_review`. Дедуп побудок не трогаем: каждый возврат остаётся законным, ограничивается их число | Наши файлы: `server/src/myrmidon/blocked-loop/{index,policy,history,settings}.ts`; в вендоре — `server/src/routes/issues.ts`: один импорт и два блока за маркером `myrmidon(BLOCKED-LOOP)` (гард в ветке `enteringBlocked`, подпись в `details` записи `issue.updated`) | Агент мог бесконечно возвращать задачу в `blocked` по условию вне зависимостей доски; каждый возврат давал новую побудку | `server/src/myrmidon/blocked-loop/policy.myrmidon.test.ts` (чистая функция и настройка), `server/src/__tests__/issue-blocked-loop.test.ts` (embedded-PG: N возвратов проходят, N+1-й отклонён, board проходит, смена блокеров и дескриптора обнуляют серию) | Никогда, наше поведение. При снятии: удалить каталог `server/src/myrmidon/blocked-loop/`, два блока в `routes/issues.ts` и строки в SETTINGS | (этот PR) |

## settings-en

| `MYRMIDON_BLOCKED_LOOP_MAX_RETURNS` | BLOCKED-LOOP | `3` | How many times in a row an agent may return one task to `blocked` with the same blocker set and the same `unblockDescriptor`; the next attempt is rejected with `422 blocked_loop_limit`. A person's action, a changed blocker set or descriptor, or a move to `done`/`cancelled`/`in_review` resets the count; board actors are never limited | Not a switch; to loosen it set up to `50`. Not an integer in `1..50` — the default |

## settings-ru

| `MYRMIDON_BLOCKED_LOOP_MAX_RETURNS` | BLOCKED-LOOP | `3` | Сколько раз подряд агент может вернуть одну задачу в `blocked` с тем же набором блокеров и тем же `unblockDescriptor`; следующая попытка отклоняется `422 blocked_loop_limit`. Действие человека, смена набора блокеров или дескриптора, уход в `done`/`cancelled`/`in_review` обнуляют счёт; board не ограничивается | Не выключатель; ослабить можно до `50`. Не целое в `1..50` — умолчание |
