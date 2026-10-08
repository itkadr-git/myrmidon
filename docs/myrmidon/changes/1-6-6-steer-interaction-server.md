---
divergence-section: 1.6.6 — UPSTREAM-STEER (часть A, сервер)
---

## changelog-en

### Owner answers to running-agent cards join the message queue: Wait / Steer / Interrupt (1.6.6 UPSTREAM-STEER, part A — server)

- A resolved interaction card (accept / answer / reject) submitted while the
  agent's run is active is now projected into the issue message queue as one
  immutable queue entry (`source.kind = "interaction"`): it cannot be edited,
  discarded or reordered, and the exact saved decision (selected options,
  approval revision) is what gets delivered.
- Delivery is explicit: ordinary run completion promotes the saved response
  (Wait), an explicit queue Steer delivers it into the compatible native turn
  with interaction provenance, and Interrupt stops the current turn and starts
  a fresh continuation — required for card answers that force a fresh session
  (e.g. plan approvals), which can no longer be steered.
- Answers to older questions no longer steer a different active run
  implicitly: the implicit steer path in question-response-delivery was
  removed (vendor PR #13539 behavior). A provider blocked on its own native
  question request still resolves that request directly.
- Anti-reassign guard: a card resolved by the finishing run — or a queued card
  response waiting for that agent — is a live review path, so an agent can no
  longer hand its issue back and orphan the owner's accepted response. The
  continuation wake is awaited (not fire-and-forget) before the queue projects
  it, and interaction receipts never coalesce with comments or other cards.

## changelog-ru

### Ответы владельца на карточки работающего агента попадают в очередь сообщений: Ожидание / Подсказ / Прерывание (1.6.6 UPSTREAM-STEER, часть A — сервер)

- Разрешённая карточка (accept / answer / reject), отправленная, пока прогон
  агента активен, проецируется в очередь сообщений задачи как один
  неизменяемый элемент (`source.kind = "interaction"`): его нельзя
  редактировать, отбрасывать или переставлять, и доставляется ровно то
  сохранённое решение (выбранные ответы, ревизия подтверждения).
- Доставка явная: обычное завершение прогона продвигает сохранённый ответ
  (Ожидание), явный Подсказ из очереди доставляет его в совместимый нативный
  ход с происхождением interaction, Прерывание останавливает текущий ход и
  начинает свежий продолжение — обязательно для ответов, требующих свежей
  сессии (например подтверждения плана), которые нельзя подсказывать.
- Ответы на старые вопросы больше НЕЯВНО не стерят чужой активный прогон:
  блок неявного steer в question-response-delivery удалён (поведение
  вендорского PR #13539). Провайдер, заблокированный на собственном
  нативном запросе, по-прежнему получает ответ напрямую в тот запрос.
- Гард против переназначения: карточка, разрешённая завершающимся прогоном,
  или ответ карточки, ожидающий в очереди этого агента, — живой путь ревью,
  поэтому агент больше не может вернуть свою задачу и осиротить принятое
  решение владельца. Продолжающий wake ожидается (не fire-and-forget) до
  проекции в очередь, а receipts карточек не сливаются с комментариями и
  другими карточками.

## divergence-new

### 1.6.6 — UPSTREAM-STEER: ответ владельца на карточку в очереди + Wait/Steer/Interrupt (часть A, сервер)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-UPSTREAM-STEER-A | Портирование вендорского PR #13539 (коммит d0b67bfe7): проекция разрешённой карточки в очередь, удаление неявного steer, anti-reassign гард, await wakeup. Отличие от вендора: модуль лежит в `server/src/myrmidon/upstream-steer/queued-interaction-response.ts` (у вендора `server/src/services/`), чтобы не плодить метки в вендорском дереве; остальные правки — по вендорскому дифу | Наши файлы: `server/src/myrmidon/upstream-steer/queued-interaction-response.ts`; в вендоре помечены `myrmidon(UPSTREAM-13539)`: `packages/shared/src/types/issue.ts`, `server/src/routes/issues.ts`, `server/src/services/{heartbeat.ts,question-response-delivery.ts,explicit-native-continuation.ts,run-identity.ts}`, `server/src/modules/wake-queue/application/use-cases.ts`, тесты `server/src/__tests__/{issue-queued-comments-routes,question-response-delivery,issue-comment-reopen-routes,issue-execution-policy-routes}.test.ts`, `server/src/modules/wake-queue/application/use-cases.test.ts` | Эпик 1.6.6 UPSTREAM-STEER: ответы на карточки работающего агента должны попадать в нашу очередь Wait/Steer/Interrupt и не стерить чужие прогоны неявно (OPE-5028, часть A — сервер; UI-часть B — отдельно) | `server/src/__tests__/issue-queued-comments-routes.test.ts` (неизменяемость interaction-элемента, Wait по умолчанию, явный Steer, Interrupt с requiresFreshSession, отказ переназначения), `question-response-delivery.test.ts` (нет неявного steer), `use-cases.test.ts` (коалесинг карточек запрещён) | Никогда, наше поведение. Снятие: удалить модуль и строки с меткой `myrmidon(UPSTREAM-13539)` | (этот PR) |
