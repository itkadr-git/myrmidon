---
divergence-section: 1.6.6 — UPSTREAM-STEER (часть B, UI)
---

## changelog-en

### Owner answers to running-agent cards join the message queue: Wait / Steer / Interrupt (1.6.6 UPSTREAM-STEER, part B — UI)

- The task-chat message queue now recognizes queue entries projected from a
  resolved interaction card (`source.kind = "interaction"`): such an entry is
  immutable — its drag handle and actions menu are disabled, no edit or
  discard is offered, and the row shows the first line of the saved response
  as its label.
- A fresh-session card answer (`source.requiresFreshSession`, e.g. a plan
  approval) or any entry on the legacy protocol offers Interrupt only; other
  interaction entries keep the Steer / Interrupt pair of the current
  steering rules.
- While an immutable interaction entry sits in the queue, reordering is
  frozen: a reorder request returns no change and positions are not
  rewritten.
- Normal queue behavior for ordinary comments (edit, discard, reorder, Steer
  / Interrupt rules) is unchanged; regression and interaction scenarios are
  covered in `ui/src/lib/issue-queued-comment-queue.test.ts` and
  `ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx`.
- Ported from upstream Paperclip PR #13539 (commit d0b67bfe7), marked with
  `myrmidon(UPSTREAM-13539)` in the touched code.

## changelog-ru

### Ответы владельца на карточки работающего агента попадают в очередь сообщений: Ожидание / Подсказ / Прерывание (1.6.6 UPSTREAM-STEER, часть B — UI)

- Очередь сообщений задачи теперь распознаёт элементы, спроецированные из
  разрешённой карточки (`source.kind = "interaction"`): такой элемент
  неизменяем — ручка перестановки и меню действий отключены, редактирование и
  отбрасывание не предлагаются, в строке показывается первая строка
  сохранённого ответа.
- Ответ карточки, требующий свежей сессии (`source.requiresFreshSession`,
  например подтверждение плана), либо любой элемент на legacy-протоколе
  получает только Прерывание; остальные interaction-элементы сохраняют пару
  Подсказ / Прерывание по действующим правилам steering.
- Пока в очереди есть неизменяемый interaction-элемент, перестановка
  заморожена: запрос перестановки не возвращает изменений и позиции не
  перезаписываются.
- Поведение обычной очереди комментариев (редактирование, отбрасывание,
  перестановка, правила Подсказ / Прерывание) не изменилось; регресс и
  interaction-сценарии покрыты тестами в
  `ui/src/lib/issue-queued-comment-queue.test.ts` и
  `ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx`.
- Перенесено из вендорского Paperclip PR #13539 (коммит d0b67bfe7) с меткой
  `myrmidon(UPSTREAM-13539)` в затронутом коде.
