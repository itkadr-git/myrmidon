---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Owner decisions find their owner when the task has none (1.6.5-OWNER-FALLBACK)

- Fixes the `via_bot` mode (1.6.5-OWNER-VIA-BOT) for tasks created by agents or by the operator service account: the owner was computed as `responsibleUserId ?? createdByUserId`, so on such tasks the author was never woken (`skipped_no_owner_dm`) and the owner of the company received nothing.
- One shared rule now picks the human who receives an owner decision: the interaction's human addressee, then the task's responsible user, then its creator, then the active owner(s) of the company (`company_memberships.membership_role = 'owner'`). The first candidate with a live Telegram DM with the author agent wins; a candidate without one is skipped.
- The same choice drives the wake of the author, the message to the owner, the "open decisions" list in the run prompt, the card-delivery lookup of the other delivery modes and the check that closes an interaction from the owner's text answer, so the person who got the message is the person whose answer is accepted.
- When nobody qualifies, the behaviour is unchanged: the question stays on the board only.
- The "explain it to the owner" wake no longer merges into the author's still-running run (which raised the question in the same turn, so the explanation block never reached its prompt). It waits behind that run and starts a separate run with the block. The response that creates a human-only interaction now carries `ownerExplain: { required: true, tool: "myrmidonMessageOwner", interactionIds }`, so the author can explain at once; a message sent in the same run cancels the deferred wake.

## changelog-ru

### Решение владельца находит владельца, когда у задачи его нет (1.6.5-OWNER-FALLBACK)

- Чинит режим `via_bot` (1.6.5-OWNER-VIA-BOT) для задач, созданных агентами или служебной учёткой оператора: владелец вычислялся как `responsibleUserId ?? createdByUserId`, поэтому на таких задачах автор не будился (`skipped_no_owner_dm`), а владелец компании ничего не получал.
- Теперь человека для решения владельца выбирает одно общее правило: адресат interaction (человек), затем ответственный по задаче, затем её создатель, затем активные владельцы компании (`company_memberships.membership_role = 'owner'`). Берётся первый кандидат с живым Telegram-диалогом с агентом-автором (вопрос с адресатом пробует только адресата: нет диалога — остаётся на доске); у кого диалога нет — пропускается.
- Тот же выбор определяет побудку автора, сообщение владельцу, список открытых решений в промпте прогона, поиск доставки карточек в других режимах и проверку закрытия interaction текстовым ответом владельца: ответ принимается от того, кому ушло сообщение.
- Если подходящих нет, поведение прежнее: вопрос остаётся только на доске.
- Побудка «объясни владельцу» больше не сливается с ещё идущим прогоном автора (он создал вопрос в этом же ходе, и блок объяснения в его промпт не попадал). Она ждёт окончания этого прогона и запускает отдельный прогон с блоком. Ответ на создание human-only interaction теперь содержит `ownerExplain: { required: true, tool: "myrmidonMessageOwner", interactionIds }`, автор может объяснить сразу; сообщение, отправленное в том же прогоне, отменяет отложенную побудку.

## divergence

| 1.6.5-OWNER-FALLBACK | Выбор получателя решения владельца вынесен в `resolveOwnerDecisionRecipient` (адресат → ответственный → создатель → активные owner компании; первый с живым Telegram-ЛС с автором) и используется в `loadOpenOwnerDecisions` и `telegramOwnerDeliveryBindings`; `authorizeOwnerReplyResolution`, `scheduleOwnerExplainWake` и `sendOwnerMessage` берут владельца из `loadOpenOwnerDecisions`, поэтому выбор един | Наши файлы: `server/src/myrmidon/owner-delivery/{owner-dialogue,telegram-owner-bindings}.ts`. Вендор помечен `myrmidon(1.6.5-OWNER-FALLBACK)`: `server/src/services/heartbeat.ts` (`shouldQueueFollowupForRunningIssueWake` откладывает побудку «объясни»), `server/src/routes/issues.ts` (поле `ownerExplain` в ответе создания interaction) | Решение владельца 07.10: владельцу уходят только решения владельца; «владелец» — человек-владелец компании. Факт на бою 08.10: задачи агентов без ответственного молча пропускались | `server/src/__tests__/owner-via-bot.myrmidon.test.ts` (блок «who the owner is»: задача агента без ответственного; ответственный без диалога; вопрос конкретному человеку; никого с диалогом) | Вернуть вычисление `responsibleUserId ?? createdByUserId` в двух местах | (этот PR) |
