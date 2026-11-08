## changelog-en

### AGENT-EXCHANGE: experience exchange rooms in the agent card (OPE-12078)

- Domain foundation for agent-to-agent experience exchange outside tickets
  (roadmap-v1 §3.3, OPE-3965): types and Zod validation for `ExchangeRoom`
  (2–4 agent participants, topic, cost_limit_cents, state
  open|finalizing|closed), `ExchangeMessage` (agent_id, content, tokens_used),
  the finisher and the stop valve (`server/src/myrmidon/agent-exchange/`).
- Pure lifecycle operations: room creation enforces 2–4 participants (a 5th is
  rejected with `too_many_participants`), participant/message addition,
  finalizing and orderly close; pulling the stop valve instantly transitions
  the room to `closed` (as does exceeding cost_limit_cents).

## changelog-ru

### AGENT-EXCHANGE: комнаты обмена опытом внутри карточки агента (OPE-12078)

- Фундамент обмена опытом между агентами вне тикетов (roadmap-v1 §3.3,
  OPE-3965): типы и Zod-валидация `ExchangeRoom` (2–4 участника-агента, тема,
  cost_limit_cents, состояние open|finalizing|closed), `ExchangeMessage`
  (agent_id, content, tokens_used), завершитель и стоп-кран
  (`server/src/myrmidon/agent-exchange/`).
- Чистые операции жизненного цикла: создание комнаты требует 2–4 участника
  (пятый отклоняется с `too_many_participants`), добавление участника и
  сообщения, финализация и штатное закрытие; стоп-кран мгновенно переводит
  комнату в `closed` (как и превышение cost_limit_cents).
