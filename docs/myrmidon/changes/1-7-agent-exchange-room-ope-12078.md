# 1.7 AGENT-EXCHANGE: схема комнат обмена опытом внутри карточки агента (OPE-12078)

## Контекст и цель
По roadmap-v1 §3.3 OPE-3965: обмен опытом между агентами вне тикетов (подзадача OPE-12078).
Реализованы типы, Zod-схема валидации и чистые функции жизненного цикла для комнаты обсуждений `ExchangeRoom`, сообщений `ExchangeMessage`, завершителя `ExchangeFinisher` и механизма стоп-крана (stop-valve).

## Что добавлено
1. `server/src/myrmidon/agent-exchange/types.ts`:
   - Состояния комнаты: `ExchangeRoomState` (`open` | `finalizing` | `closed`);
   - Границы участников: `MIN_EXCHANGE_PARTICIPANTS = 2`, `MAX_EXCHANGE_PARTICIPANTS = 4`;
   - Доменные сущности `ExchangeParticipant`, `ExchangeFinisher`, `ExchangeMessage`, `ExchangeRoom`;
   - Ошибки домена `ExchangeRoomError` с типизированными кодами.

2. `server/src/myrmidon/agent-exchange/schema.ts`:
   - Zod-схемы с валидацией инвариантов: 2–4 уникальных участника, обязательная тема, лимит расходов, флаг `stop_valve === true` требует немедленного перехода состояния в `closed`;
   - Валидация сообщений `ExchangeMessage` (`agent_id`, `content`, `tokens_used`);
   - Хелперы `validateExchangeRoom`, `validateExchangeMessage`, `safeValidateExchangeRoom`, `validateParticipants`.

3. `server/src/myrmidon/agent-exchange/room.ts`:
   - Чистые функции управления состоянием: `createExchangeRoom`, `addParticipant`, `pullStopValve`, `finalizeExchangeRoom`, `closeExchangeRoom`, `addExchangeMessage`;
   - Защита от 5-го участника (`too_many_participants`);
   - Немедленный перевод в `closed` при вызове стоп-крана `pullStopValve` или превышении `cost_limit_cents`.

4. `server/src/myrmidon/agent-exchange/index.ts` и `domain/`:
   - Полный реэкспорт контрактов для потребителей.

5. `server/src/myrmidon/agent-exchange/exchange-room.myrmidon.test.ts`:
   - Модульные тесты Vitest, покрывающие все критерии приёмки:
     * Комната с 2, 3, 4 участниками создаётся успешно;
     * Попытка создания с 5 участниками или добавления 5-го участника выбрасывает ошибку;
     * Попытка создания с менее чем 2 участниками отклоняется;
     * Вызов стоп-крана немедленно переводит статус в `closed`;
     * Схема отклоняет несогласованное состояние `stop_valve: true` при `state !== 'closed'`;
     * Проверка сообщений, аккумуляция токенов и завершитель.
