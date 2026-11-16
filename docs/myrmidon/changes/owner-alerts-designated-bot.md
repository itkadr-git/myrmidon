## changelog-en

### Owner system signals come from the designated agent's chat, never from an arbitrary bot

On 16.11 the board signal "Bot partition is critically full ..." reached the owner in Telegram from the shop bot, a bot unrelated to the board. All bots live in one company, and the owner-delivery lookup took any active direct Telegram chat of the company. The same lookup picked the recipient of bot update notices. A new company setting `telegramNotify.owner.agentId` (an agent uuid, `null` by default) names the agent whose chat carries these signals: set it with `PATCH /api/myrmidon/telegram-notify` and `{"owner": {"agentId": "<agent uuid>"}}`. Only an active direct chat of that agent's endpoint is used, the newest activity first. With no agent designated, or no chat with it, no chat is picked at random: the signal falls back to `updates.chatId`, and when that is empty too it stays on the attention card with a log entry. Recipients set explicitly are unchanged.

## changelog-ru

### Системные сигналы владельцу идут из чата назначенного агента, а не от случайного бота

16.11 сигнал доски «Bot partition is critically full ...» пришёл владельцу в Telegram от бота магазина, не имеющего отношения к доске. Все боты состоят в одной компании, а поиск канала доставки владельцу брал любую активную личную переписку Telegram компании. Той же функцией выбирался получатель уведомлений об обновлении ботов. Новая настройка компании `telegramNotify.owner.agentId` (uuid агента, по умолчанию `null`) называет агента, чей чат несёт такие сигналы: задаётся через `PATCH /api/myrmidon/telegram-notify` с телом `{"owner": {"agentId": "<uuid агента>"}}`. Берётся только активная личная переписка endpoint-а этого агента, сначала с последней активностью. Если агент не назначен или переписки с ним нет, случайная не берётся: сигнал идёт в `updates.chatId`, а если и его нет, остаётся карточкой внимания с записью в журнал. Явно заданные получатели не меняются.
