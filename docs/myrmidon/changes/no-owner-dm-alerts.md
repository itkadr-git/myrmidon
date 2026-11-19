## changelog-en

### The board no longer sends the owner Telegram messages about disk space or updates

Fact (16 Nov): the owner received two disk-space messages from the BBQ shop bot. The board picked "any active direct conversation of any bot" as the owner recipient. The board no longer messages the owner in direct chats. Disk alerts for the bot partition and the host root stay as board cards in the attention feed (the card still appears below 10% free space). Bot update notifications go only to the explicitly configured `updates.chatId` and `topicId`. If they are not configured, the event is only written to the log. Why: the alert channel is monitoring (Zabbix, the alerts topic), not the board.

## changelog-ru

### Доска больше не пишет владельцу в Telegram о заполнении диска и об обновлениях

Факт 16.11: владелец получил два сообщения о заполнении тома ботов от бота магазина BBQ. Доска выбирала получателем любую активную личную переписку любого бота. Теперь доска владельцу в личку не пишет. Сигналы о разделе ботов и корне хоста остаются карточками на доске (карточка по-прежнему появляется при менее 10% свободного места). Уведомления об обновлениях ботов идут только в явно настроенные `updates.chatId` и `topicId`; если они не настроены, событие только пишется в журнал. Почему: канал алертов — мониторинг (Zabbix, топик алертов), а не доска.
